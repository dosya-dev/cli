import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { LIVE_API, runCli, getWorkspaceId, uploadTestFile, deleteFile } from "../helpers";

describe.skipIf(!LIVE_API)("dosya download --zip", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;
    let a: string;
    let b: string;
    let outPath: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
        a = await uploadTestFile(workspaceId);
        b = await uploadTestFile(workspaceId);
        outPath = join(process.env.TMPDIR || "/tmp", `dosya-zip-${Date.now()}.zip`);
    });

    afterAll(async () => {
        await deleteFile(a);
        await deleteFile(b);
        try { unlinkSync(outPath); } catch { /* ignore */ }
    });

    it("writes a zip with the PK magic bytes", async () => {
        const { exitCode } = await runCli([
            "download", "--zip", a, b, "-o", outPath, "-w", workspaceId, "--force", "-k", apiKey,
        ]);
        expect(exitCode).toBe(0);
        expect(existsSync(outPath)).toBe(true);
        const head = readFileSync(outPath).subarray(0, 2).toString("latin1");
        expect(head).toBe("PK");
    });
});
