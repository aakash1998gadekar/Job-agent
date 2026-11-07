#!/usr/bin/env node

/**
 * lib/email-notify.mjs — Gmail SMTP notification module
 *
 * Uses nodemailer with Gmail App Password for sending job digests
 * and profile update confirmations.
 *
 * Test mode: node lib/email-notify.mjs --test
 */

import nodemailer from 'nodemailer';
import { loadAgentConfig, validateAgentConfig } from './config-loader.mjs';

/**
 * Create a Gmail SMTP transporter.
 */
function createTransporter(emailConfig) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    family: 4, // Force IPv4 — prevents EHOSTUNREACH on networks without IPv6
    auth: {
      user: emailConfig.from,
      pass: emailConfig.app_password,
    },
  });
}

/**
 * Send a job digest email with new job matches.
 * @param {object[]} jobs - Array of { title, company, location, salary, url, source }
 * @param {object} emailConfig - { to, from, app_password, subject_prefix }
 */
export async function sendJobDigest(jobs, emailConfig) {
  const transporter = createTransporter(emailConfig);
  const date = new Date().toISOString().split('T')[0];

  const naukriJobs = jobs.filter(j => j.source === 'naukri');
  const linkedinJobs = jobs.filter(j => j.source === 'linkedin');

  const htmlBody = buildDigestHtml(naukriJobs, linkedinJobs, date);

  const info = await transporter.sendMail({
    from: `"Career-Ops Bot" <${emailConfig.from}>`,
    to: emailConfig.to,
    subject: `${emailConfig.subject_prefix} Daily Job Digest — ${date} (${jobs.length} new)`,
    html: htmlBody,
  });

  console.log(`✉️  Digest sent: ${info.messageId} (${jobs.length} jobs)`);
  return info;
}

/**
 * Send a profile update confirmation email.
 * @param {object} status - { success, timestamp, error? }
 * @param {object} emailConfig
 */
export async function sendProfileUpdateConfirmation(status, emailConfig) {
  const transporter = createTransporter(emailConfig);

  const subject = status.success
    ? `${emailConfig.subject_prefix} Naukri profile updated ✅`
    : `${emailConfig.subject_prefix} Naukri profile update FAILED ❌`;

  const html = `
    <div style="font-family: -apple-system, sans-serif; padding: 20px;">
      <h2 style="color: ${status.success ? '#16a34a' : '#dc2626'};">
        ${status.success ? '✅ Profile Updated' : '❌ Update Failed'}
      </h2>
      <p><strong>Timestamp:</strong> ${status.timestamp}</p>
      ${status.error ? `<p><strong>Error:</strong> ${status.error}</p>` : ''}
      <p style="color: #6b7280; font-size: 12px;">
        This is an automated notification from career-ops job agents.
      </p>
    </div>
  `;

  const info = await transporter.sendMail({
    from: `"Career-Ops Bot" <${emailConfig.from}>`,
    to: emailConfig.to,
    subject,
    html,
  });

  console.log(`✉️  Profile update notification sent: ${info.messageId}`);
  return info;
}

/**
 * Build HTML email body for job digest.
 */
function buildDigestHtml(naukriJobs, linkedinJobs, date) {
  const jobRow = (job) => {
    const matchPct = job.matchPercent || 0;
    const matchColor = matchPct >= 70 ? '#16a34a' : matchPct >= 50 ? '#ca8a04' : '#6b7280';
    const matchBg = matchPct >= 70 ? '#dcfce7' : matchPct >= 50 ? '#fef9c3' : '#f3f4f6';
    return `
    <tr>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">
        <span style="background: ${matchBg}; color: ${matchColor}; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600;">
          ${matchPct}%
        </span>
      </td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">
        <a href="${job.url}" style="color: #2563eb; text-decoration: none; font-weight: 500;">${job.title}</a>
      </td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">${job.company}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">${job.location || '—'}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">
        <span style="background: ${job.source === 'naukri' ? '#3b82f6' : '#0ea5e9'}; color: white; padding: 2px 8px; border-radius: 12px; font-size: 11px;">
          ${job.source}
        </span>
      </td>
    </tr>
  `;
  };

  const tableHeader = `
    <tr style="background: #f9fafb;">
      <th style="padding: 8px 12px; text-align: center; border-bottom: 2px solid #e5e7eb;">Match</th>
      <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Title</th>
      <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Company</th>
      <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Location</th>
      <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Source</th>
    </tr>
  `;

  const allJobs = [...naukriJobs, ...linkedinJobs];

  return `
    <!DOCTYPE html>
    <html>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: #f3f4f6;">
      <div style="max-width: 700px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <div style="background: #1e293b; padding: 20px 24px;">
          <h1 style="color: white; margin: 0; font-size: 20px;">📋 Career-Ops Daily Digest</h1>
          <p style="color: #94a3b8; margin: 4px 0 0 0; font-size: 14px;">${date} — ${allJobs.length} new matching jobs</p>
        </div>

        <div style="padding: 24px;">
          ${naukriJobs.length > 0 ? `
            <h2 style="font-size: 16px; color: #1e293b; margin-bottom: 12px;">
              🔵 Naukri (${naukriJobs.length} new)
            </h2>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
              ${tableHeader}
              ${naukriJobs.map(jobRow).join('')}
            </table>
          ` : ''}

          ${linkedinJobs.length > 0 ? `
            <h2 style="font-size: 16px; color: #1e293b; margin-bottom: 12px;">
              🔷 LinkedIn (${linkedinJobs.length} new)
            </h2>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
              ${tableHeader}
              ${linkedinJobs.map(jobRow).join('')}
            </table>
          ` : ''}
        </div>

        <div style="background: #f9fafb; padding: 16px 24px; border-top: 1px solid #e5e7eb;">
          <p style="color: #6b7280; font-size: 12px; margin: 0;">
            Scanned ${allJobs.length} new matches • Sent by career-ops job agents
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

// ── Auto-Apply Report Email ─────────────────────────────────────────

/**
 * Send a report of auto-applied jobs.
 * @param {object[]} appliedJobs - Array of jobs that were applied to
 * @param {object} emailConfig - { from, to, app_password, subject_prefix }
 */
export async function sendAutoApplyReport(appliedJobs, emailConfig) {
  const transporter = createTransporter(emailConfig);
  const date = new Date().toISOString().split('T')[0];

  const jobRows = appliedJobs.map(job => `
    <tr>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">
        <span style="background: #16a34a; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px;">${job.matchScore || job.matchPercent || '?'}%</span>
      </td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">
        <a href="${job.url}" style="color: #2563eb; text-decoration: none;">${job.title}</a>
      </td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">${job.company}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">${job.location || '—'}</td>
    </tr>
  `).join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: #f3f4f6;">
      <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <div style="background: #16a34a; padding: 20px 24px;">
          <h1 style="color: white; margin: 0; font-size: 20px;">🤖 Auto-Apply Report</h1>
          <p style="color: #dcfce7; margin: 4px 0 0 0; font-size: 14px;">${date} — ${appliedJobs.length} applications submitted</p>
        </div>
        <div style="padding: 24px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr style="background: #f9fafb;">
              <th style="padding: 8px 12px; text-align: center; border-bottom: 2px solid #e5e7eb;">Match</th>
              <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Title</th>
              <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Company</th>
              <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Location</th>
            </tr>
            ${jobRows}
          </table>
        </div>
        <div style="background: #f9fafb; padding: 16px 24px; border-top: 1px solid #e5e7eb;">
          <p style="color: #6b7280; font-size: 12px; margin: 0;">
            Auto-applied via career-ops • Check Naukri "Applied Jobs" to verify
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  const info = await transporter.sendMail({
    from: `"Career-Ops Bot" <${emailConfig.from}>`,
    to: emailConfig.to,
    subject: `${emailConfig.subject_prefix} 🤖 Auto-Applied to ${appliedJobs.length} jobs`,
    html,
  });

  console.log(`✉️  Auto-apply report sent: ${info.messageId}`);
  return info;
}

// ── CLI test mode ──────────────────────────────────────────────────
if (process.argv[1]?.endsWith('email-notify.mjs') && process.argv.includes('--test')) {
  const config = loadAgentConfig();
  validateAgentConfig(config, ['email']);

  const testJobs = [
    { title: 'Senior AI Engineer', company: 'Test Corp', location: 'Bangalore', salary: '₹25-40 LPA', url: 'https://example.com/job1', source: 'naukri' },
    { title: 'ML Engineer', company: 'Demo Inc', location: 'Remote', salary: '—', url: 'https://example.com/job2', source: 'linkedin' },
  ];

  await sendJobDigest(testJobs, config.email);
  console.log('✅ Test email sent successfully!');
}
