export function firstSurvivingApprovalId(
  followingIds: readonly string[],
  remainingIds: readonly string[],
): string | undefined {
  const remaining = new Set(remainingIds);
  return followingIds.find((id) => remaining.has(id));
}
