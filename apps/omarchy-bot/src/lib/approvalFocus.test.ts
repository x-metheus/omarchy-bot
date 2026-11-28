import { expect, test } from "bun:test";
import { firstSurvivingApprovalId } from "./approvalFocus.ts";

test("targets C when B is answered and A and B disappear together", () => {
  const displayedIds = ["A", "B", "C", "D"];
  const followingIds = displayedIds.slice(displayedIds.indexOf("B") + 1);
  expect(firstSurvivingApprovalId(followingIds, ["C", "D"])).toBe("C");
});

test("skips removed approvals and keeps the captured order", () => {
  expect(firstSurvivingApprovalId(["C", "D", "E"], ["E", "D"])).toBe("D");
});

test("returns undefined when none of the following approvals survive", () => {
  expect(firstSurvivingApprovalId(["C", "D"], ["A", "E"])).toBeUndefined();
});
