# JEV support-ticket router

A small TypeScript project that routes customer-support messages using
[JEV](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway), TypeSafe AI's "decision model",
through the Vercel AI Gateway.

JEV doesn't write text. You give it a message and a list of questions, and it returns typed answers with probabilities.
For each ticket this project asks four questions:

| Question | Type | Answer |
|---|---|---|
| Which team should handle it? | choice | billing, shipping, product_support, technical_support, other |
| How urgent is it? | score | Low / Medium / High (0 to 2) |
| Does it need a human? | boolean | probability |
| What is the main reason for writing? | choice | 11 reason codes, e.g. `double_charge` |

Those answers are turned into a queue name (`shipping-urgent`, `human-review`, `billing`, ...).

## Requirements

- **Node.js 22 or later** (the AI SDK requires it)
- A **Vercel AI Gateway API key** with access to the `typesafe-ai/jev` model.
  JEV was in early access when this was written, so access may need to be requested.

## Setup

```bash
npm install
```

Create your own `.env` file from the template and paste your key into it:

```bash
# macOS / Linux / Git Bash
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

Then edit `.env` so it reads `AI_GATEWAY_API_KEY=your-key-here`. The `.env` file is git-ignored and is never committed.

## Run it

**Smallest example** (one message, three questions, printed as raw answers):

```bash
npm run example
```

**Batch mode.** Sends all tickets in `tickets.json` (1,000 synthetic messages) at once:

```bash
npm start
npm start -- 100        # in batches of 100 instead
```

**Real-time simulation.** Tickets arrive in random groups of 1 to 5, 100 ms to 5 s apart, and each one is sent to JEV
as it arrives. The default is 200 tickets, which takes about 3 minutes. The random schedule is seeded, so every run is identical.

```bash
npm run realtime
npm run realtime -- 50              # only 50 tickets
```

You can also call the script directly:

```bash
npx tsx --env-file=.env router.ts batch [batchSize] [ticketsFile]
npx tsx --env-file=.env router.ts realtime [count] [ticketsFile] [seed]
```

### Optional: turn off the SDK's automatic retries

The AI SDK retries failed requests twice by default. To run an experiment without retries, set `MAX_RETRIES` for that run:

```powershell
$env:MAX_RETRIES = "0"; npm start        # PowerShell
```
```bash
MAX_RETRIES=0 npm start                  # macOS / Linux / Git Bash
```

## Output

Each run prints a table of the first 20 tickets, a count per queue, and timing metrics. It also writes two files
(both are git-ignored):

- `routed.json` — every ticket, grouped by queue
- `metrics-batch-<size>.json` or `metrics-realtime-<count>.json` — timing results, including the time each answer came back

## Files

| File | Purpose |
|---|---|
| `router.ts` | The router, with both run modes and the benchmark metrics |
| `jev.ts` | A small standalone example of calling JEV with a few questions |
| `tickets.json` | 1,000 synthetic support messages |
| `tsconfig.json` | TypeScript settings |

Check types with `npm run typecheck`.

## Notes

- The tickets are synthetic, generated from message templates. Routing quality was eyeballed, not measured against labelled data.
- JEV occasionally returns a tie between options, which the SDK reports as an error
  (`did not select a highest-probability option`). In testing this affected roughly 1 ticket in 1,000. The router catches the error and
  puts that ticket in an `error` queue.
- Running a large batch sends many requests at once. Check your Vercel AI Gateway usage if you are watching costs.
