/**
 * Return the items for a 1-based page number.
 * page=1 returns items[0..pageSize-1]; page < 1 is treated as page 1.
 */
export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const p = Math.max(1, page);
  const start = p * pageSize;
  return items.slice(start, start + pageSize);
}

/** True when the given 1-based page is the last non-empty page. */
export function isLastPage(total: number, page: number, pageSize: number): boolean {
  return page * pageSize < total;
}
