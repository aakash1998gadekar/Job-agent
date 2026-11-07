#!/usr/bin/env node
/**
 * Quick test: Send a sample digest email with match percentages.
 */
import { sendJobDigest } from './lib/email-notify.mjs';
import { loadAgentConfig, validateAgentConfig } from './lib/config-loader.mjs';

const config = loadAgentConfig();
validateAgentConfig(config, ['email']);

const testJobs = [
  { title: 'SOC Analyst', company: 'Infosys', location: 'Bengaluru', url: 'https://naukri.com/test1', source: 'naukri', matchPercent: 55 },
  { title: 'Cloud Security Engineer', company: 'Amazon', location: 'Hyderabad', url: 'https://naukri.com/test2', source: 'naukri', matchPercent: 65 },
  { title: 'Cybersecurity Engineer', company: 'Palo Alto', location: 'Bengaluru', url: 'https://naukri.com/test3', source: 'naukri', matchPercent: 75 },
  { title: 'SIEM Engineer - Wazuh', company: 'TCS', location: 'Pune', url: 'https://linkedin.com/test4', source: 'linkedin', matchPercent: 55 },
  { title: 'Security Architect', company: 'Accenture', location: 'Remote', url: 'https://linkedin.com/test5', source: 'linkedin', matchPercent: 50 },
  { title: 'Java Developer', company: 'Wipro', location: 'Chennai', url: 'https://naukri.com/test6', source: 'naukri', matchPercent: 30 },
];

console.log('Sending test email with match percentages...');
await sendJobDigest(testJobs, config.email);
console.log('✅ Done!');
