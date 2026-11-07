#!/usr/bin/env node

/**
 * job-digest.mjs — Daily orchestrator
 *
 * Runs Naukri + LinkedIn scanners, merges results, and sends
 * an email digest of new matching job openings.
 *
 * Usage:
 *   node job-digest.mjs              # scan + email
 *   node job-digest.mjs --dry-run    # scan without writing, print email body
 *   node job-digest.mjs --naukri     # Naukri only
 *   node job-digest.mjs --linkedin   # LinkedIn only
 */

import { loadAgentConfig, validateAgentConfig } from './lib/config-loader.mjs';
import { sendJobDigest } from './lib/email-notify.mjs';
import { scanNaukri } from './scan-naukri.mjs';
import { scanLinkedIn } from './scan-linkedin.mjs';
import { scanNaukriGulf } from './scan-naukrigulf.mjs';
import { addMatchScores } from './lib/resume-match.mjs';
import { waitForNetwork } from './lib/wait-ready.mjs';
import { writeFileSync, existsSync, readFileSync } from 'fs';

// ── Main orchestrator ───────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const naukriOnly = process.argv.includes('--naukri');
  const linkedinOnly = process.argv.includes('--linkedin');

  // Wait for internet (handles sleep/wake where WiFi isn't ready yet)
  if (!dryRun) {
    console.log('⏳ Waiting for network...');
    const online = await waitForNetwork();
    if (!online) {
      console.error('❌ No internet after 300s. Aborting.');
      process.exit(1);
    }
    console.log('✅ Network ready\n');
  }

  const config = loadAgentConfig();

  // Validate email config (required for sending)
  if (!dryRun) {
    validateAgentConfig(config, ['email']);
  }

  console.log('═══════════════════════════════════════════════');
  console.log('  📋 Career-Ops Job Digest');
  console.log(`  📅 ${new Date().toISOString().split('T')[0]}`);
  console.log('═══════════════════════════════════════════════\n');

  let allJobs = [];

  // Run Naukri scan
  if (!linkedinOnly && config.naukri.enabled) {
    console.log('── Naukri Scanner ─────────────────────────────\n');
    try {
      const naukriJobs = await scanNaukri({ dryRun });
      allJobs.push(...naukriJobs);
    } catch (err) {
      console.error(`❌ Naukri scan failed: ${err.message}\n`);
    }
  }

  // Run LinkedIn scan
  if (!naukriOnly && config.linkedin.enabled) {
    console.log('\n── LinkedIn Scanner ───────────────────────────\n');
    try {
      const linkedinJobs = await scanLinkedIn({ dryRun });
      allJobs.push(...linkedinJobs);
    } catch (err) {
      console.error(`❌ LinkedIn scan failed: ${err.message}\n`);
    }
  }

  // Run Naukri Gulf scan
  if (config.naukri_gulf?.enabled) {
    console.log('\n── Naukri Gulf Scanner ────────────────────────\n');
    try {
      const gulfJobs = await scanNaukriGulf({ dryRun });
      allJobs.push(...gulfJobs);
    } catch (err) {
      console.error(`❌ Naukri Gulf scan failed: ${err.message}\n`);
    }
  }

  // Add resume match scores and sort by best match
  allJobs = addMatchScores(allJobs);

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  📊 Total new matches: ${allJobs.length}`);
  console.log('═══════════════════════════════════════════════\n');

  // Save qualified jobs to auto-apply queue
  const minApplyScore = config.auto_apply?.min_match_score || 50;
  const applyEligible = allJobs.filter(j => (j.matchPercent || 0) >= minApplyScore && (['naukri', 'naukrigulf'].includes(j.source)));
  if (applyEligible.length > 0 && !dryRun) {
    // Merge with existing queue (don't lose previously queued jobs)
    const queuePath = 'data/to-apply.json';
    let existingQueue = [];
    try {
      if (existsSync(queuePath)) existingQueue = JSON.parse(readFileSync(queuePath, 'utf-8'));
    } catch {}
    const existingIds = new Set(existingQueue.map(j => j.jobId));
    const newForQueue = applyEligible
      .filter(j => !existingIds.has(j.jobId))
      .map(j => ({ ...j, matchScore: j.matchPercent, queuedAt: new Date().toISOString() }));
    const updatedQueue = [...existingQueue, ...newForQueue];
    writeFileSync(queuePath, JSON.stringify(updatedQueue, null, 2));
    console.log(`🤖 Auto-apply queue: ${newForQueue.length} new jobs added (${updatedQueue.length} total in queue)`);
  } else if (applyEligible.length > 0) {
    console.log(`🤖 Auto-apply queue: would add ${applyEligible.length} eligible jobs (dry-run)`);
  }

  // Send email digest
  if (allJobs.length >= config.email.min_matches) {
    if (dryRun) {
      console.log('📧 Would send email with these jobs:\n');
      for (const job of allJobs.slice(0, 20)) {
        console.log(`  [${job.matchPercent}%] [${job.source}] ${job.title} @ ${job.company} — ${job.location}`);
        console.log(`         ${job.url}\n`);
      }
      if (allJobs.length > 20) console.log(`  ... and ${allJobs.length - 20} more jobs`);
    } else {
      try {
        await sendJobDigest(allJobs, config.email);
        console.log('✅ Digest email sent successfully!');
      } catch (err) {
        console.error(`❌ Failed to send email: ${err.message}`);
        process.exit(1);
      }
    }
  } else {
    console.log(`📭 Only ${allJobs.length} matches (threshold: ${config.email.min_matches}). No email sent.`);
  }
}

// ── Run ─────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
