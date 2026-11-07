/**
 * lib/skills-reorder.mjs — Reorders Naukri Key Skills based on JD keywords
 *
 * Strategy: Given a batch of jobs to apply to, extract the most common
 * keywords from their titles, then reorder the user's existing skills
 * to put JD-relevant ones first. This helps ATS keyword matching.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── All skills from cv.md (master list — order doesn't matter here) ─

const ALL_SKILLS = [
  // SIEM & Monitoring
  'Wazuh', 'Elastic Stack', 'Elasticsearch', 'Logstash', 'Kibana', 'Splunk', 'Grafana', 'Prometheus', 'InfluxDB',
  // Cloud Security
  'AWS', 'IAM', 'EC2', 'S3', 'CloudTrail', 'GuardDuty', 'Inspector', 'Security Hub', 'AWS WAF',
  'Microsoft Azure', 'Azure Sentinel', 'CSPM', 'CWPP',
  // Endpoint & Network
  'CrowdStrike Falcon', 'EDR', 'XDR', 'Microsoft Defender', 'Meraki', 'Firewall', 'IDS/IPS', 'VPN', 'Wireshark', 'Nmap',
  // Security Tools
  'Proofpoint', 'PhishER', 'GTB DLP', 'Qualys', 'Nessus', 'Vulcan', 'Prophaze WAF', 'Burp Suite', 'OWASP ZAP',
  // SOAR & Automation
  'n8n', 'Claude AI', 'Vulcan SOAR', 'Python', 'Bash', 'REST APIs', 'Postman', 'Power Automate',
  // IAM
  'RBAC', 'MFA', 'SSO', 'Active Directory', 'Azure AD', 'Entra ID', 'PAM',
  // Threat Intelligence
  'MITRE ATT&CK', 'IOC Analysis', 'Threat Hunting', 'Incident Response', 'Digital Forensics', 'Malware Analysis',
  // Compliance
  'Vulnerability Management', 'CVSS', 'CVE', 'OWASP Top 10', 'NIST CSF', 'ISO 27001', 'SOC 2', 'Zero Trust', 'CIS Benchmarks',
  // Data & Scripting
  'JSON', 'YAML', 'SQL', 'Regex', 'KQL',
  // Networking
  'TCP/IP', 'DNS', 'HTTP/HTTPS', 'SMTP', 'TLS/SSL', 'DHCP',
  // Ticketing
  'Jira', 'ServiceDesk Plus', 'Confluence', 'Slack',
  // General security terms
  'SIEM', 'SOC', 'DLP', 'SOAR', 'WAF', 'DevSecOps', 'AppSec', 'GRC', 'Cybersecurity', 'Information Security',
  'Cloud Security', 'Endpoint Security', 'Network Security', 'Security Operations', 'Penetration Testing',
  'Security Automation', 'Detection Engineering', 'Log Analysis', 'Security Architecture',
];

// ── Keyword extraction from job titles ──────────────────────────────

const SKILL_KEYWORDS_MAP = {
  // Map common JD title words → related skills to prioritize
  'siem': ['Wazuh', 'Splunk', 'Elastic Stack', 'SIEM', 'Elasticsearch', 'Kibana', 'Log Analysis', 'KQL'],
  'soc': ['SOC', 'Incident Response', 'MITRE ATT&CK', 'CrowdStrike Falcon', 'EDR', 'Threat Hunting', 'SOAR'],
  'cloud': ['AWS', 'Microsoft Azure', 'Cloud Security', 'GuardDuty', 'Security Hub', 'CloudTrail', 'CSPM', 'CWPP'],
  'aws': ['AWS', 'IAM', 'CloudTrail', 'GuardDuty', 'Inspector', 'Security Hub', 'AWS WAF', 'Cloud Security'],
  'azure': ['Microsoft Azure', 'Azure Sentinel', 'Azure AD', 'Entra ID', 'Cloud Security'],
  'endpoint': ['CrowdStrike Falcon', 'EDR', 'XDR', 'Microsoft Defender', 'Endpoint Security'],
  'devsecops': ['DevSecOps', 'Python', 'Bash', 'OWASP Top 10', 'Burp Suite', 'OWASP ZAP', 'Security Automation'],
  'appsec': ['AppSec', 'OWASP Top 10', 'Burp Suite', 'OWASP ZAP', 'Prophaze WAF', 'WAF'],
  'application security': ['AppSec', 'OWASP Top 10', 'Burp Suite', 'OWASP ZAP', 'WAF', 'REST APIs'],
  'vulnerability': ['Vulnerability Management', 'Qualys', 'Nessus', 'CVSS', 'CVE', 'Vulcan'],
  'threat': ['Threat Hunting', 'MITRE ATT&CK', 'IOC Analysis', 'Incident Response', 'Malware Analysis'],
  'detection': ['Detection Engineering', 'MITRE ATT&CK', 'Wazuh', 'Elastic Stack', 'SIEM', 'KQL'],
  'automation': ['Security Automation', 'Python', 'n8n', 'SOAR', 'REST APIs', 'Power Automate', 'Bash'],
  'network': ['Network Security', 'Firewall', 'IDS/IPS', 'VPN', 'Wireshark', 'Nmap', 'TCP/IP'],
  'iam': ['IAM', 'RBAC', 'MFA', 'SSO', 'Active Directory', 'Azure AD', 'PAM'],
  'dlp': ['GTB DLP', 'DLP', 'Proofpoint', 'Information Security'],
  'grc': ['GRC', 'ISO 27001', 'SOC 2', 'NIST CSF', 'CIS Benchmarks', 'Zero Trust'],
  'compliance': ['ISO 27001', 'SOC 2', 'NIST CSF', 'CIS Benchmarks', 'OWASP Top 10', 'GRC'],
  'incident': ['Incident Response', 'SOAR', 'n8n', 'MITRE ATT&CK', 'Digital Forensics'],
  'forensics': ['Digital Forensics', 'Malware Analysis', 'Incident Response', 'Wireshark'],
  'penetration': ['Penetration Testing', 'Burp Suite', 'OWASP ZAP', 'Nmap', 'Wireshark'],
  'python': ['Python', 'Security Automation', 'REST APIs', 'Bash'],
  'splunk': ['Splunk', 'SIEM', 'KQL', 'Log Analysis'],
  'crowdstrike': ['CrowdStrike Falcon', 'EDR', 'XDR', 'Endpoint Security'],
  'wazuh': ['Wazuh', 'SIEM', 'Elastic Stack', 'Detection Engineering'],
  'secops': ['Security Operations', 'SOC', 'SOAR', 'Incident Response', 'Security Automation'],
  'security operations': ['Security Operations', 'SOC', 'SOAR', 'Incident Response', 'CrowdStrike Falcon'],
  'information security': ['Information Security', 'ISO 27001', 'GRC', 'Vulnerability Management', 'IAM'],
  'cybersecurity': ['Cybersecurity', 'SIEM', 'SOC', 'Incident Response', 'Cloud Security', 'EDR'],
  'zero trust': ['Zero Trust', 'IAM', 'MFA', 'SSO', 'Network Security'],
};

/**
 * Given a list of job objects (with .title), return the top N skills
 * from ALL_SKILLS reordered by relevance to the batch.
 *
 * @param {Array<{title: string}>} jobs - Jobs to analyze
 * @param {number} maxSkills - Max skills to return (Naukri shows ~20 key skills)
 * @returns {string[]} Ordered list of skills, most relevant first
 */
export function getReorderedSkills(jobs, maxSkills = 20) {
  // Count keyword hits across all job titles
  const skillScores = new Map();

  for (const job of jobs) {
    const titleLower = job.title.toLowerCase();

    for (const [keyword, relatedSkills] of Object.entries(SKILL_KEYWORDS_MAP)) {
      if (titleLower.includes(keyword)) {
        for (const skill of relatedSkills) {
          skillScores.set(skill, (skillScores.get(skill) || 0) + 1);
        }
      }
    }
  }

  // Sort ALL_SKILLS by score (higher = more relevant to batch), then by original order
  const scored = ALL_SKILLS.map((skill, idx) => ({
    skill,
    score: skillScores.get(skill) || 0,
    originalIdx: idx,
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIdx - b.originalIdx;
  });

  // Return top N unique skills
  const seen = new Set();
  const result = [];
  for (const { skill } of scored) {
    const normalized = skill.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(skill);
      if (result.length >= maxSkills) break;
    }
  }

  return result;
}

/**
 * Get a comma-separated string of top skills for Naukri profile update
 */
export function getSkillsString(jobs, maxSkills = 20) {
  return getReorderedSkills(jobs, maxSkills).join(', ');
}
