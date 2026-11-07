#!/usr/bin/env node

/**
 * lib/resume-match.mjs — Resume matching scorer
 *
 * Compares job title, company, and location against the user's CV skills
 * and profile to produce a match percentage (0-100%).
 */

import { readFileSync, existsSync } from 'fs';

// ── Load resume keywords once ───────────────────────────────────────

let cachedKeywords = null;

function loadResumeKeywords() {
  if (cachedKeywords) return cachedKeywords;

  const keywords = new Set();

  // Load from cv.md
  if (existsSync('cv.md')) {
    const cv = readFileSync('cv.md', 'utf-8').toLowerCase();
    
    // Extract key technical terms
    const techTerms = [
      // SIEM & Monitoring
      'wazuh', 'elastic', 'elasticsearch', 'logstash', 'kibana', 'elk', 'splunk',
      'grafana', 'prometheus', 'siem', 'influxdb',
      // Cloud Security
      'aws', 'azure', 'cloud', 'iam', 'cloudtrail', 'guardduty', 'inspector',
      'security hub', 'waf', 'sentinel', 'cspm', 'cwpp',
      // Endpoint & Network
      'crowdstrike', 'falcon', 'edr', 'xdr', 'defender', 'meraki', 'firewall',
      'ids', 'ips', 'vpn', 'wireshark', 'nmap',
      // Security Tools
      'proofpoint', 'phisher', 'dlp', 'qualys', 'nessus', 'vulcan', 'prophaze',
      'burp suite', 'owasp', 'zap',
      // SOAR & Automation
      'soar', 'n8n', 'automation', 'python', 'bash', 'api', 'rest',
      'power automate', 'playbook',
      // IAM
      'rbac', 'mfa', 'sso', 'active directory', 'azure ad', 'entra', 'pam',
      // Threat Intel
      'mitre', 'att&ck', 'ioc', 'threat hunting', 'incident response',
      'forensics', 'malware',
      // Compliance
      'vulnerability', 'cvss', 'cve', 'owasp', 'nist', 'iso 27001', 'soc 2',
      'zero trust', 'cis', 'compliance', 'grc',
      // General Security
      'soc', 'security', 'cybersecurity', 'infosec', 'information security',
      'detection', 'monitoring', 'incident', 'threat', 'vulnerability',
      'penetration', 'pentest', 'red team', 'blue team',
      // Data & Scripting
      'sql', 'regex', 'kql', 'json', 'yaml',
      // Networking
      'tcp', 'dns', 'http', 'tls', 'ssl',
      // Tools
      'jira', 'confluence', 'servicenow',
    ];

    for (const term of techTerms) {
      if (cv.includes(term)) {
        keywords.add(term);
      }
    }
  }

  cachedKeywords = keywords;
  return keywords;
}

/**
 * Calculate match percentage between a job and the resume.
 * Uses additive scoring: start at 30, earn points for each signal.
 * @param {object} job - { title, company, location, salary, url }
 * @returns {number} Match percentage 0-100
 */
export function calculateMatch(job) {
  const keywords = loadResumeKeywords();
  const titleLower = (job.title || '').toLowerCase();
  const jobText = `${job.title || ''} ${job.company || ''} ${job.location || ''} ${job.salary || ''}`.toLowerCase();

  let score = 30; // Base score for any job that passed title filter

  // ─── Core role match (up to +30) ───────────────────────────────
  const coreTerms = ['soc', 'security', 'cybersecurity', 'infosec', 'information security'];
  const coreHits = coreTerms.filter(t => titleLower.includes(t)).length;
  score += Math.min(30, coreHits * 15);

  // ─── Specific domain match in title (up to +20) ────────────────
  const domainTerms = ['siem', 'cloud security', 'incident response', 'threat',
    'detection', 'vulnerability', 'edr', 'soar', 'dlp', 'devsecops',
    'penetration', 'pentest', 'forensics', 'malware'];
  const domainHits = domainTerms.filter(t => titleLower.includes(t)).length;
  score += Math.min(20, domainHits * 10);

  // ─── Tool/tech match anywhere in job text (up to +15) ──────────
  const toolTerms = ['wazuh', 'splunk', 'elastic', 'elk', 'crowdstrike', 'sentinel',
    'nessus', 'qualys', 'burp', 'wireshark', 'nmap', 'python', 'aws', 'azure'];
  const toolHits = toolTerms.filter(t => keywords.has(t) && jobText.includes(t)).length;
  score += Math.min(15, toolHits * 5);

  // ─── Role level match (up to +5) ──────────────────────────────
  if (titleLower.includes('analyst') || titleLower.includes('engineer')) score += 5;
  if (titleLower.includes('senior') || titleLower.includes('lead') || titleLower.includes('principal')) score -= 5;
  if (titleLower.includes('junior') || titleLower.includes('intern')) score -= 10;

  // ─── Location bonus (+5) ──────────────────────────────────────
  const preferredLocations = ['bangalore', 'bengaluru', 'pune', 'hyderabad', 'remote'];
  const locationLower = (job.location || '').toLowerCase();
  if (preferredLocations.some(loc => locationLower.includes(loc))) score += 5;

  // ─── Experience fit (+5) ──────────────────────────────────────
  const expMatch = jobText.match(/(\d+)\s*(?:to|-)\s*(\d+)\s*(?:year|yr)/i);
  if (expMatch) {
    const minExp = parseInt(expMatch[1]);
    const maxExp = parseInt(expMatch[2]);
    if (minExp <= 4 && maxExp >= 2) score += 5;
    else if (minExp > 6) score -= 10; // Too senior
  }

  return Math.min(95, Math.max(20, score));
}

/**
 * Add match percentage to an array of jobs.
 * @param {object[]} jobs
 * @returns {object[]} Jobs with matchPercent field added
 */
export function addMatchScores(jobs) {
  return jobs.map(job => ({
    ...job,
    matchPercent: calculateMatch(job),
  })).sort((a, b) => b.matchPercent - a.matchPercent); // Sort by best match first
}
