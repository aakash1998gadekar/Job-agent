#!/usr/bin/env node

/**
 * lib/dedup.mjs — Shared deduplication logic for job scanners
 *
 * Tracks seen job IDs and URLs across scan history files.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';

/**
 * Load seen job IDs from a TSV history file.
 * @param {string} historyPath - Path to the TSV history file
 * @returns {Set<string>} - Set of seen job IDs
 */
export function loadSeenIds(historyPath) {
  const seen = new Set();
  if (existsSync(historyPath)) {
    const lines = readFileSync(historyPath, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const id = line.split('\t')[0];
      if (id) seen.add(id);
    }
  }
  return seen;
}

/**
 * Load seen URLs from a TSV history file.
 * @param {string} historyPath - Path to the TSV history file
 * @returns {Set<string>} - Set of seen URLs
 */
export function loadSeenUrls(historyPath) {
  const seen = new Set();
  if (existsSync(historyPath)) {
    const lines = readFileSync(historyPath, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const parts = line.split('\t');
      const url = parts[1]; // url is second column
      if (url) seen.add(url);
    }
  }
  return seen;
}

/**
 * Load seen company::role pairs from applications.md
 * @param {string} applicationsPath
 * @returns {Set<string>}
 */
export function loadSeenCompanyRoles(applicationsPath) {
  const seen = new Set();
  if (existsSync(applicationsPath)) {
    const text = readFileSync(applicationsPath, 'utf-8');
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

/**
 * Initialize history TSV file with header if it doesn't exist.
 * @param {string} historyPath
 * @param {string} header - TSV header line
 */
export function ensureHistoryFile(historyPath, header) {
  if (!existsSync(historyPath)) {
    writeFileSync(historyPath, header + '\n', 'utf-8');
  }
}

/**
 * Append entries to a TSV history file.
 * @param {string} historyPath
 * @param {string[]} lines - Array of TSV lines to append
 */
export function appendToHistory(historyPath, lines) {
  if (lines.length === 0) return;
  appendFileSync(historyPath, lines.join('\n') + '\n', 'utf-8');
}
