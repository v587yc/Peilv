// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { downloadBlob } from "@/features/odds/excel-export-client";

describe("downloadBlob", () => {
  it("downloads with the requested filename and always revokes the object URL", () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:excel-test");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    downloadBlob(new Blob([new Uint8Array([0x50, 0x4b])]), "赔率数据_20260719.xlsx");

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:excel-test");
    expect(document.querySelector("a")).toBeNull();
  });
});
