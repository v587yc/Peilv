#!/usr/bin/env python3
import argparse, gzip, hashlib, json, os, pathlib, re, shutil, stat, tarfile

HERE = pathlib.Path(__file__).resolve().parent
LIMITS = json.loads((HERE / "release-limits.json").read_text("utf-8"))

def normalized(raw):
    if not isinstance(raw, str) or not raw or not raw.isascii() or any(ord(c) < 0x21 or ord(c) > 0x7e for c in raw): raise ValueError("Unsupported archive member name")
    if "\\" in raw: raise ValueError("Backslash archive path rejected")
    value = re.sub(r"^(\./)+", "", raw).rstrip("/")
    if not value or value == ".": return None
    parts = value.split("/")
    if value.startswith("/") or any(x in ("", ".", "..") for x in parts): raise ValueError("Unsafe archive path")
    if len(value.encode()) > LIMITS["maxPathBytes"] or len(parts) > LIMITS["maxPathDepth"]: raise ValueError("Archive path limit exceeded")
    if any(x in LIMITS["forbiddenSegments"] for x in parts): raise ValueError("Archive contains a forbidden member")
    if any(re.search(x, parts[-1], re.I) for x in LIMITS["forbiddenBasenamePatterns"]) or any(re.search(x, value, re.I) for x in LIMITS["forbiddenPathPatterns"]): raise ValueError("Archive contains a forbidden member")
    return value

def inspect_file(fileobj, size):
    if size <= 0 or size > LIMITS["maxArchiveBytes"]: raise ValueError("Archive compressed size limit exceeded")
    seen, files, total = {}, set(), 0
    fileobj.seek(0)
    with tarfile.open(fileobj=fileobj, mode="r:gz") as tf:
        for index, member in enumerate(tf):
            if index >= LIMITS["maxMembers"]: raise ValueError("Archive member limit exceeded")
            if member.pax_headers: raise ValueError("PAX archive metadata rejected")
            name = normalized(member.name)
            if name is None: continue
            if name in seen: raise ValueError(f"Duplicate normalized archive path: {name}")
            if not (member.isfile() or member.isdir()) or member.islnk() or member.issym(): raise ValueError("Archive contains a link or special file")
            kind = "d" if member.isdir() else "f"; seen[name] = kind
            for i in range(1, len(name.split("/"))):
                parent = "/".join(name.split("/")[:i])
                if seen.get(parent) == "f": raise ValueError(f"Archive file/directory conflict: {parent}")
            if kind == "f":
                if member.size > LIMITS["maxFileBytes"]: raise ValueError("Archive file size limit exceeded")
                total += member.size; files.add(name)
                if total > LIMITS["maxTotalBytes"]: raise ValueError("Archive total size limit exceeded")
        for name, kind in seen.items():
            if kind == "f" and any(other.startswith(name + "/") for other in seen): raise ValueError(f"Archive file/directory conflict: {name}")
    if total and total / size > LIMITS["maxCompressionRatio"]: raise ValueError("Archive compression ratio limit exceeded")
    return seen

def inspect(archive):
    info=os.stat(archive, follow_symlinks=False)
    with open(archive,"rb") as value: return inspect_file(value,info.st_size)

def extract_file(fileobj, size, destination):
    seen = inspect_file(fileobj,size); root = pathlib.Path(destination).resolve()
    if any(root.iterdir()): raise ValueError("Extraction directory must be empty")
    fileobj.seek(0)
    with tarfile.open(fileobj=fileobj, mode="r:gz") as tf:
        for member in tf:
            name = normalized(member.name)
            if name is None: continue
            target = root.joinpath(*name.split("/"))
            if member.isdir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
                if target.is_symlink() or not target.is_dir(): raise ValueError("Unsafe extraction directory")
            else:
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                source = tf.extractfile(member)
                if source is None: raise ValueError("Archive file has no data")
                with open(target, "xb") as output: shutil.copyfileobj(source, output, 1024 * 1024)
                os.chmod(target, member.mode & 0o777)

def extract(archive, destination):
    info=os.stat(archive, follow_symlinks=False)
    with open(archive,"rb") as value: extract_file(value,info.st_size,destination)

def verify_extract(archive, destination, expected):
    fd=os.open(archive, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1: raise ValueError("Archive must be a single-link regular file")
        digest=hashlib.sha256()
        while True:
            block=os.read(fd,1024*1024)
            if not block: break
            digest.update(block)
        actual=digest.hexdigest()
        if actual != expected: raise ValueError("Archive checksum mismatch")
        with os.fdopen(os.dup(fd),"rb") as value: extract_file(value,before.st_size,destination)
        after=os.fstat(fd)
        fields=("st_dev","st_ino","st_size","st_ctime_ns","st_mtime_ns","st_mode","st_nlink")
        if any(getattr(before,x)!=getattr(after,x) for x in fields): raise ValueError("Archive changed during verification")
        os.lseek(fd,0,os.SEEK_SET); confirm=hashlib.sha256()
        while True:
            block=os.read(fd,1024*1024)
            if not block: break
            confirm.update(block)
        if confirm.hexdigest()!=actual: raise ValueError("Archive content changed during verification")
        print(actual)
    finally: os.close(fd)

def check_tree(source):
    root = pathlib.Path(source).resolve(); entries=[]; total=0
    for item in sorted(root.rglob("*"), key=lambda x: x.relative_to(root).as_posix()):
        rel=item.relative_to(root).as_posix(); normalized(rel); info=item.lstat()
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)) or (stat.S_ISREG(info.st_mode) and info.st_nlink != 1): raise ValueError("Stage contains link, special file, or hard link")
        if stat.S_ISREG(info.st_mode):
            if info.st_size > LIMITS["maxFileBytes"]: raise ValueError("Stage file size limit exceeded")
            total += info.st_size
        entries.append((item, rel, info))
    if len(entries) > LIMITS["maxMembers"] or total > LIMITS["maxTotalBytes"]: raise ValueError("Stage resource limit exceeded")
    return root, entries

def create(source, archive):
    root, entries = check_tree(source)
    with open(archive, "xb") as raw:
      with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
       with tarfile.open(fileobj=gz, mode="w", format=tarfile.USTAR_FORMAT) as tf:
        for item, rel, info in entries:
            ti=tf.gettarinfo(str(item), arcname=rel); ti.uid=ti.gid=0;ti.uname=ti.gname="";ti.mtime=0
            if ti.isfile():
                with open(item,"rb") as value: tf.addfile(ti,value)
            else: tf.addfile(ti)
    inspect(archive)

p=argparse.ArgumentParser(); sub=p.add_subparsers(dest="cmd",required=True)
for cmd in ("inspect","extract"): q=sub.add_parser(cmd);q.add_argument("archive");q.add_argument("destination",nargs="?")
q=sub.add_parser("check-tree");q.add_argument("source")
q=sub.add_parser("create");q.add_argument("source");q.add_argument("archive")
q=sub.add_parser("verify-extract");q.add_argument("archive");q.add_argument("destination");q.add_argument("expected")
a=p.parse_args()
if a.cmd=="inspect": inspect(a.archive)
elif a.cmd=="extract": extract(a.archive,a.destination)
elif a.cmd=="check-tree": check_tree(a.source)
elif a.cmd=="verify-extract": verify_extract(a.archive,a.destination,a.expected)
else: create(a.source,a.archive)
