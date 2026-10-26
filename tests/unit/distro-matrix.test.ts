import { expect, test } from "bun:test";
import matrix from "../../scripts/distro-conformance/matrix.json";

test("distribution matrix names all seven required hosts with a native Alpine image", () => {
  expect(matrix.map(row => row.id)).toEqual(["ubuntu-22.04", "ubuntu-24.04", "debian-12", "fedora", "arch", "opensuse", "alpine"]);
  expect(new Set(matrix.map(row => row.id)).size).toBe(7);
  expect(matrix.find(row => row.id === "alpine")).toEqual({ id: "alpine", image: "alpine:3.21.3", family: "alpine" });
});
