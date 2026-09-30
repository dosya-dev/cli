import { describe, it, expect } from "bun:test";
import { resolveRoleFlag, roleNameOf, type RoleRow } from "../../src/commands/member";

const roles: RoleRow[] = [
    { id: "role_admin", name: "Admin", is_builtin: true, is_custom: false, permissions: { manage_roles: true } },
    { id: "role_member", name: "Member", is_builtin: true, is_custom: false, permissions: {} },
    { id: "role_viewer", name: "Viewer", is_builtin: true, is_custom: false, permissions: {} },
    { id: "role_c1", name: "Ops Lead", is_builtin: false, is_custom: true, permissions: { upload_files: true } },
    { id: "role_c2", name: "Reviewer", is_builtin: false, is_custom: true, permissions: {} },
    { id: "role_c3", name: "reviewer", is_builtin: false, is_custom: true, permissions: {} },
];

describe("resolveRoleFlag", () => {
    it("passes a built-in name or any role id through untouched (the server resolves those)", () => {
        expect(resolveRoleFlag("Admin", roles)).toBe("Admin");
        expect(resolveRoleFlag("role_member", roles)).toBe("role_member");
        expect(resolveRoleFlag("role_c1", roles)).toBe("role_c1");
    });

    it("resolves a custom role's NAME to its id, case-insensitively", () => {
        expect(resolveRoleFlag("ops lead", roles)).toBe("role_c1");
        expect(resolveRoleFlag("OPS LEAD", roles)).toBe("role_c1");
    });

    it("refuses an ambiguous name instead of guessing", () => {
        expect(() => resolveRoleFlag("reviewer", roles)).toThrow(/ambiguous/i);
    });

    it("passes an unknown value through so the server's error names it", () => {
        expect(resolveRoleFlag("Nope", roles)).toBe("Nope");
    });
});

describe("roleNameOf", () => {
    it("names a known id and falls back to the id", () => {
        expect(roleNameOf("role_c1", roles)).toBe("Ops Lead");
        expect(roleNameOf("role_zzz", roles)).toBe("role_zzz");
        expect(roleNameOf("role_admin", [])).toBe("role_admin");
    });
});
