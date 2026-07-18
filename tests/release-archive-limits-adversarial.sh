#!/bin/bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; work="$(mktemp -d)"; trap 'rm -rf -- "$work"' EXIT HUP INT TERM
cp "$root/scripts/release-archive.py" "$work/release-archive.py"
cat >"$work/release-limits.json" <<'JSON'
{"schemaVersion":1,"maxArchiveBytes":1048576,"maxMembers":5,"maxFileBytes":32,"maxTotalBytes":64,"maxPathBytes":80,"maxPathDepth":4,"maxCompressionRatio":3,"forbiddenSegments":[".git",".cache"],"forbiddenBasenamePatterns":["^\.env(?:$|\.)"],"forbiddenPathPatterns":[]}
JSON
create_case(){
 local scenario="$1" archive="$work/$scenario.tar.gz"
 SCENARIO="$scenario" ARCHIVE="$archive" python - <<'PYCASE'
import gzip,io,os,tarfile
s=os.environ['SCENARIO']; out=os.environ['ARCHIVE']
with gzip.GzipFile(out,'wb',mtime=0) as gz:
 with tarfile.open(fileobj=gz,mode='w',format=tarfile.USTAR_FORMAT) as tf:
  def add(name,data=b'x',pax=None):
   i=tarfile.TarInfo(name); i.size=len(data); i.mode=0o600
   if pax: i.pax_headers=pax
   tf.addfile(i,io.BytesIO(data))
  if s=='space': add('bad name')
  elif s=='tab': add('bad\tname')
  elif s=='newline': add('bad\nname')
  elif s=='pax': add('pax',pax={'comment':'x'})
  elif s=='longname':
   i=tarfile.TarInfo('././@LongLink'); i.type=tarfile.GNUTYPE_LONGNAME; data=b'a'*100+b'\0'; i.size=len(data); tf.addfile(i,io.BytesIO(data))
  elif s=='members':
   for n in range(6): add(f'f{n}')
  elif s=='single': add('huge',b'x'*33)
  elif s=='total': add('a',b'x'*32); add('b',b'x'*32); add('c',b'x')
  elif s=='depth': add('a/b/c/d/e')
  elif s=='ratio': add('bomb',b'0'*32)
PYCASE
 printf '%s' "$archive"
}
for scenario in space tab newline pax longname members single total depth ratio; do
 archive="$(create_case "$scenario")"; destination="$work/$scenario-tree"; mkdir "$destination"; sha="$(sha256sum "$archive"|awk '{print $1}')"
 if python "$work/release-archive.py" verify-extract "$archive" "$destination" "$sha" >/dev/null 2>&1; then printf 'FAIL accepted_%s\n' "$scenario" >&2; exit 1; fi
 [[ -z "$(find "$destination" -mindepth 1 -print -quit)" ]] || { printf 'FAIL extracted_%s\n' "$scenario" >&2; exit 1; }
 printf 'PASS rejected_%s\n' "$scenario"
done
