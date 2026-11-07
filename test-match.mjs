#!/usr/bin/env node
import { calculateMatch, addMatchScores } from './lib/resume-match.mjs';

const testJobs = [
  { title: 'SOC Analyst', company: 'Infosys', location: 'Bengaluru', source: 'naukri', url: 'http://test1' },
  { title: 'Cloud Security Engineer', company: 'Amazon', location: 'Hyderabad', source: 'naukri', url: 'http://test2' },
  { title: 'SIEM Engineer - Wazuh', company: 'TCS', location: 'Pune', source: 'linkedin', url: 'http://test3' },
  { title: 'Java Developer', company: 'Wipro', location: 'Chennai', source: 'naukri', url: 'http://test4' },
  { title: 'Security Architect', company: 'Accenture', location: 'Remote', source: 'naukri', url: 'http://test5' },
  { title: 'Incident Response Analyst', company: 'CrowdStrike', location: 'Bengaluru', source: 'linkedin', url: 'http://test6' },
  { title: 'Cybersecurity Engineer 2-5 years', company: 'Palo Alto', location: 'Bengaluru', source: 'naukri', url: 'http://test7' },
  { title: 'Network Security Engineer', company: 'Cisco', location: 'Remote', source: 'linkedin', url: 'http://test8' },
  { title: 'Data Analyst', company: 'Flipkart', location: 'Bengaluru', source: 'naukri', url: 'http://test9' },
  { title: 'Vulnerability Analyst - ELK Stack', company: 'IBM', location: 'Pune', source: 'naukri', url: 'http://test10' },
];

const scored = addMatchScores(testJobs);
console.log('\n=== Resume Match Test ===\n');
for (const j of scored) {
  console.log(`  [${j.matchPercent}%] [${j.source}] ${j.title} @ ${j.company} — ${j.location}`);
}
console.log('\n✅ Match scoring works!\n');
