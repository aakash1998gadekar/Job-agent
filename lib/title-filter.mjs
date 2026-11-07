#!/usr/bin/env node

/**
 * lib/title-filter.mjs — Shared title filtering logic
 *
 * Extracted from scan.mjs for reuse across Naukri/LinkedIn scanners.
 */

/**
 * Build a title filter function from positive/negative keyword lists.
 * @param {object} titleFilter - { positive: string[], negative: string[] }
 * @returns {(title: string) => boolean} - Returns true if title passes filter
 */
export function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}
