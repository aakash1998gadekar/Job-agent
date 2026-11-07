# Naukri Screening Questions — Reference for Future Automation

## Common Questions Encountered During Auto-Apply

Based on Naukri's chatbot-style application form, these are the typical fields/questions:

### Standard Fields (Already Handled Automatically)
| Field | Type | Our Answer | Config Key |
|-------|------|-----------|------------|
| Notice Period | Select dropdown | "15 Days" | `agents.auto_apply.notice_period` |
| Current CTC (in Lakhs) | Text input | "20" | `agents.auto_apply.current_ctc` |
| Expected CTC (in Lakhs) | Text input | "30" | `agents.auto_apply.expected_ctc` |
| Resume | File upload | `Resume (1).pdf` | auto from workspace |

### Screening Questions (Not Yet Automated — Logged to `data/screening-questions.json`)

These are extra questions some companies ask. When detected, the bot skips the job and logs the question for review.

#### Frequently Asked Questions:
1. **"Are you willing to relocate?"** — Yes / No
2. **"What is your current location?"** — Bangalore / Pune / Hyderabad
3. **"Are you comfortable with night shifts?"** — Yes (for SOC roles)
4. **"Do you have hands-on experience with [specific tool]?"** — Yes / No
5. **"How many years of experience in [domain]?"** — Numeric input
6. **"Are you open to contract/temporary roles?"** — Yes / No
7. **"Do you have relevant certifications?"** — Yes: CompTIA Security+, CEH, etc.
8. **"What is your preferred work mode?"** — Hybrid / Remote / WFO
9. **"Are you currently serving notice period?"** — Yes / No
10. **"Date of availability to join"** — Date picker

### Phase 2 Automation Plan

To automate screening questions in future:

1. **Collect Data**: Let the bot run for a week, logging all encountered questions to `data/screening-questions.json`
2. **Build Answer Map**: Create a `config/screening-answers.yml` with pattern-matched answers:
   ```yaml
   screening_answers:
     relocate: "Yes"
     location: "Bangalore"
     night_shift: "Yes"
     work_mode: "Hybrid"
     notice_serving: "No"
     certifications: "CompTIA Security+, CEH"
   ```
3. **Implement Matcher**: In `handleApplyForm()`, match detected field labels against the answer map
4. **Fill & Submit**: Auto-fill matched fields, skip only truly unknown questions

### How It Works Today

```
Job in queue → Open page → Click Apply → 
  Chatbot form opens →
    Fill notice period ✅
    Fill current CTC ✅  
    Fill expected CTC ✅
    Check for unknown fields →
      If found: LOG to data/screening-questions.json + SKIP
      If none: Click Submit ✅
```

### File Locations
- Queue: `data/to-apply.json`
- Apply history: `data/apply-history.tsv`
- Screening questions log: `data/screening-questions.json`
- Auto-apply log: `logs/auto-apply.log`
- Config: `config/profile.yml` → `agents.auto_apply`
