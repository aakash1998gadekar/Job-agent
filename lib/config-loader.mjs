#!/usr/bin/env node

/**
 * lib/config-loader.mjs — Shared config loader for job agents
 *
 * Reads config/profile.yml agents section + env vars for secrets.
 * Validates required fields and throws descriptive errors if missing.
 */

import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import { config as loadDotenv } from 'dotenv';

// Load .env if present (local development)
loadDotenv();

const PROFILE_PATH = 'config/profile.yml';

export function loadConfig() {
  if (!existsSync(PROFILE_PATH)) {
    throw new Error(`Missing ${PROFILE_PATH}. Run onboarding first or copy from config/profile.example.yml`);
  }

  const raw = readFileSync(PROFILE_PATH, 'utf-8');
  const profile = yaml.load(raw);

  return profile;
}

export function loadAgentConfig() {
  const profile = loadConfig();
  const agents = profile.agents || {};

  return {
    profile: { full_name: profile.full_name || profile.name || '' },
    naukri: {
      enabled: agents.naukri?.enabled ?? true,
      email: process.env.NAUKRI_EMAIL || agents.naukri?.email || '',
      password: process.env.NAUKRI_PASSWORD || '',
      keywords: agents.naukri?.keywords || [],
      location: agents.naukri?.location || [],
      experience_range: agents.naukri?.experience_range || '5-10',
      sort_by: agents.naukri?.sort_by || 'date',
    },
    linkedin: {
      enabled: agents.linkedin?.enabled ?? true,
      email: process.env.LINKEDIN_EMAIL || agents.linkedin?.email || '',
      password: process.env.LINKEDIN_PASSWORD || '',
      keywords: agents.linkedin?.keywords || [],
      location: agents.linkedin?.location || 'India',
      geo_id: agents.linkedin?.geo_id || '102713980',
      time_filter: agents.linkedin?.time_filter || 'r86400',
      remote_filter: agents.linkedin?.remote_filter ?? false,
    },
    naukri_gulf: {
      enabled: agents.naukri_gulf?.enabled ?? false,
      keywords: agents.naukri_gulf?.keywords || [],
      location: agents.naukri_gulf?.location || [],
      experience_range: agents.naukri_gulf?.experience_range || '3-8',
    },
    email: {
      to: process.env.GMAIL_USER || agents.email?.to || '',
      from: process.env.GMAIL_USER || agents.email?.from || '',
      app_password: process.env.GMAIL_APP_PASSWORD || '',
      subject_prefix: agents.email?.subject_prefix || '[Career-Ops]',
      min_matches: agents.email?.min_matches ?? 1,
    },
    title_filter: profile.agents?.title_filter || agents.title_filter || null,
    auto_apply: {
      enabled: agents.auto_apply?.enabled ?? false,
      platform: agents.auto_apply?.platform || 'naukri',
      daily_limit: agents.auto_apply?.daily_limit ?? 10,
      min_match_score: agents.auto_apply?.min_match_score ?? 50,
      notice_period: agents.auto_apply?.notice_period || '15 Days',
      current_ctc: agents.auto_apply?.current_ctc || '20',
      expected_ctc: agents.auto_apply?.expected_ctc || '30',
      delay_between_applies_ms: agents.auto_apply?.delay_between_applies_ms ?? 45000,
      skip_external_redirects: agents.auto_apply?.skip_external_redirects ?? true,
      skip_screening_questions: agents.auto_apply?.skip_screening_questions ?? true,
    },
  };
}

export function validateAgentConfig(config, requiredSections = ['email']) {
  const errors = [];

  if (requiredSections.includes('email')) {
    if (!config.email.to) errors.push('Missing email recipient (set GMAIL_USER env var or agents.email.to in profile.yml)');
    if (!config.email.app_password) errors.push('Missing GMAIL_APP_PASSWORD env var');
  }

  if (requiredSections.includes('naukri')) {
    if (!config.naukri.email) errors.push('Missing NAUKRI_EMAIL env var or agents.naukri.email in profile.yml');
    if (!config.naukri.password) errors.push('Missing NAUKRI_PASSWORD env var');
    if (config.naukri.keywords.length === 0) errors.push('No Naukri keywords configured in agents.naukri.keywords');
  }

  if (requiredSections.includes('linkedin')) {
    if (config.linkedin.keywords.length === 0) errors.push('No LinkedIn keywords configured in agents.linkedin.keywords');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n  - ${errors.join('\n  - ')}`);
  }

  return true;
}
