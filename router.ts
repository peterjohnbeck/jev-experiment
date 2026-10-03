import { experimental_evaluate as evaluate } from 'ai';
import { readFile, writeFile } from 'node:fs/promises';

// How many times the AI SDK re-sends a failed request. This is an AI SDK setting that runs on YOUR
// machine (not a Vercel Gateway setting). The SDK default is 2; set the environment variable
// MAX_RETRIES=0 to turn retries off for an experiment. `undefined` means "use the default".
// `process.env` holds environment variables (Python: os.environ).
const MAX_RETRIES = process.env.MAX_RETRIES === undefined ? undefined : Number(process.env.MAX_RETRIES);

// STEP 3: defining our own types
// `type` gives a name to a shape. It's like a TypedDict or dataclass in Python,
// but it only exists for the editor; it disappears when the code runs.

// A union of string literals: a value can ONLY be one of these exact strings.
// (Python's closest equivalent is Literal['billing', 'shipping', ...].)
type Team = 'billing' | 'shipping' | 'product_support' | 'technical_support' | 'other';

// An incoming message.
type Ticket = {
  id: number;
  text: string;
};

// What we want back for each ticket.
type Route = {
  team: Team;
  urgency: number;     // 0 (Low) to 2 (High)
  needsHuman: boolean; // true if probability of "needs a human" is over 50%
  reason: string;      // a short label for what the message is about, e.g. 'double_charge'
};

async function classify(ticket: Ticket): Promise<Route> {
  const result = await evaluate({
    model: 'typesafe-ai/jev',
    maxRetries: MAX_RETRIES,
    state: ticket.text,
    questions: {
      team: {
        type: 'choice',
        instructions: 'Which team should handle this message?',
        criteria: { billing: null, shipping: null, product_support: null, technical_support: null, other: null },
      },
      urgency: {
        type: 'score',
        instructions: 'How urgent is this message?',
        criteria: ['Low', 'Medium', 'High'],
      },
      needsHuman: {
        type: 'boolean',
        instructions: 'Does this message need a human to look at it, rather than an automated reply?',
      },
      // The "reason code": a specific label for what the message is about.
      // Each option has a short description (instead of null) to tell JEV what it means.
      reason: {
        type: 'choice',
        instructions: 'What is the main reason this customer is writing?',
        criteria: {
          double_charge: 'Customer was charged more than once',
          refund_request: 'Customer wants money back or a subscription cancelled',
          missing_package: 'Order not delivered, or marked delivered but not received',
          delivery_delay: 'Order is late but still on its way',
          return_request: 'Customer wants to return or exchange a product',
          assembly_help: 'Customer needs help setting up or using a product',
          login_problem: 'Customer cannot log in or the app crashes',
          account_change: 'Customer wants to change their account details',
          general_question: 'A question about the store, such as opening hours',
          praise: 'Customer is happy and saying thanks',
          other: 'Nothing else fits',
        },
      },
    },
  });

  return {
    team: result.answers.team.choice as Team, // `as Team` tells TS "trust me, it's one of these"
    urgency: result.answers.urgency.score,
    needsHuman: result.answers.needsHuman.probability > 0.5,
    reason: result.answers.reason.choice,
  };
}

// STEP 8: two ways to run the program
//   batch    = give it the whole pile of tickets at once
//   realtime = simulate tickets arriving on a random schedule
//
// Usage:
//   npx tsx --env-file=.env router.ts batch [batchSize] [file]
//       default: every ticket in a single batch
//   npx tsx --env-file=.env router.ts realtime [count] [file] [seed]
//       default: the first 200 tickets, seed 42
//
// `process.argv` is Python's `sys.argv` (index 0 = node, 1 = the script, 2 = first real argument).
const MODE = process.argv[2];
if (MODE !== 'batch' && MODE !== 'realtime') {
  console.error('Usage: router.ts batch [batchSize] [file]\n       router.ts realtime [count] [file] [seed]');
  process.exit(1);   // after this, TypeScript knows MODE is 'batch' or 'realtime'
}
const NUMBER_ARG = Number(process.argv[3]);          // the batch size, or the ticket count (NaN if missing)
const TICKETS_FILE = process.argv[4] || 'tickets.json';
const SEED = Number(process.argv[5]) || 42;          // `a || b` means "a, unless it is empty/0/NaN, then b"

// STEP 4: reading a JSON file
// `readFile` comes from Node's built-in `node:fs/promises` module (like Python's `open().read()`).
// It is async, so we `await` it. The `'utf-8'` argument makes it return text instead of raw bytes.
const fileText = await readFile(TICKETS_FILE, 'utf-8');

// JSON.parse turns the text into real objects (like Python's json.loads).
// It returns `any`, so we TELL TypeScript what to expect with `as Ticket[]`.
// `Ticket[]` means "an array of Tickets" (Python: list[Ticket]).
// TypeScript can't check the file's contents, so this is a promise we make.
const allTickets = JSON.parse(fileText) as Ticket[];

// Real-time sends only the first N tickets (it is slow by design); batch uses them all.
const tickets = MODE === 'realtime' ? allTickets.slice(0, NUMBER_ARG || 200) : allTickets;

console.log(`Loaded ${tickets.length} tickets (mode: ${MODE})\n`);   // backticks + ${...} = Python f-string

// STEP 5: loops and routing logic
const URGENCY_LABELS = ['Low', 'Medium', 'High'];   // an array, like a Python list

// Decide which queue a routed ticket goes to. `if / else if / else` works like
// Python's `if / elif / else`, but with parentheses and curly braces.
function pickQueue(route: Route): string {
  const level = Math.round(route.urgency);   // 1.79 -> 2 (High)

  if (level === 2) {                 // `===` is the strict equality check (use it instead of ==)
    return `${route.team}-urgent`;
  } else if (route.needsHuman) {
    return 'human-review';
  } else {
    return route.team;
  }
}

// STEP 6: collecting results and printing them nicely
// One row of output. We build a list of these as we go.
type Row = {
  id: number;
  urgency: string;
  queue: string;
  reason: string;
  text: string;
};

// STEP 7: error handling and timing
// Cut long text to 50 characters. `.length` and `.slice(a, b)` work like len() and [a:b].
function shorten(text: string): string {
  return text.length > 50 ? text.slice(0, 50) + '…' : text;
}

// How long each individual ticket took (in milliseconds), for the benchmark.
const ticketTimes: number[] = [];
// WHEN each ticket finished, in milliseconds since the run started (`startTime`).
const finishTimes: number[] = [];
let startTime = 0;   // `let` = a variable we are allowed to change; each runner sets it when it starts

// Process ONE ticket and always return a Row, even if something goes wrong.
// try/catch is Python's try/except: if anything inside `try` throws an error,
// the `catch` block runs instead of the whole program crashing.
async function processTicket(ticket: Ticket): Promise<Row> {
  const ticketStart = Date.now();
  try {
    const route = await classify(ticket);
    ticketTimes.push(Date.now() - ticketStart);
    finishTimes.push(Date.now() - startTime);
    return {
      id: ticket.id,
      urgency: URGENCY_LABELS[Math.round(route.urgency)],
      queue: pickQueue(route),
      reason: route.reason,
      text: shorten(ticket.text),
    };
  } catch (error) {
    ticketTimes.push(Date.now() - ticketStart);
    finishTimes.push(Date.now() - startTime);
    console.error(`Ticket #${ticket.id} failed:`, error instanceof Error ? error.message : error);
    // A failed ticket goes to a queue of its own, so a human can look at it.
    return { id: ticket.id, urgency: '?', queue: 'error', reason: '?', text: shorten(ticket.text) };
  }
}

// PATH 1: BATCH
// Within a batch everything runs at the same time; the next batch only starts when
// the previous one is completely finished. One batch holding every ticket = "all at once".
// The function returns an OBJECT with two parts (Python: a tuple or a dict).
async function runBatch(batchSize: number): Promise<{ rows: Row[]; batchTimes: number[] }> {
  const rows: Row[] = [];
  const batchTimes: number[] = [];   // how long each batch took, in milliseconds
  startTime = Date.now();            // milliseconds since 1970

  // A classic `for` loop: start at 0, stop at the end, jump forward batchSize each time.
  for (let i = 0; i < tickets.length; i += batchSize) {
    const batch = tickets.slice(i, i + batchSize);
    const batchStart = Date.now();

    // `batch.map(processTicket)` starts one request per ticket; `Promise.all` waits for the whole batch.
    // Results come back in the SAME order. (Python: `await asyncio.gather(*[...])`)
    const batchRows = await Promise.all(batch.map(processTicket));

    rows.push(...batchRows);   // `...` spreads the list out, so all its items are added (Python: rows.extend(batchRows))
    batchTimes.push(Date.now() - batchStart);
  }
  return { rows, batchTimes };
}

// PATH 2: REAL-TIME SIMULATOR
// Tickets arrive in groups of 1 to 5, with a random 100 ms to 5 s gap between groups.
// A ticket is sent to JEV the moment it "arrives"; we do NOT wait for the answer before
// the next group shows up, so several can be in flight at once.

// A random number generator you can SEED: the same seed always gives the same sequence,
// so every run has the same arrival pattern. (Python: random.Random(seed).)
// `makeRandom` returns a FUNCTION that remembers `state` between calls (a "closure").
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;   // a number from 0 up to (but not including) 1
  };
}

// Pause for `ms` milliseconds without blocking anything else (Python: await asyncio.sleep(ms / 1000)).
// A Promise that finishes when the timer fires; `await sleep(500)` waits for it.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runRealtime(seed: number): Promise<{ rows: Row[]; groups: number; peakInFlight: number }> {
  const random = makeRandom(seed);
  const pending: Promise<Row>[] = [];   // one unfinished Promise per ticket sent
  let next = 0;                         // index of the next ticket to send
  let scheduledAt = 0;                  // when (ms after the start) the next group arrives
  let groups = 0;
  let inFlight = 0;                     // tickets sent but not yet answered
  let peakInFlight = 0;
  startTime = Date.now();

  while (next < tickets.length) {
    // 1 to 5 tickets, but never more than remain.
    const size = Math.min(1 + Math.floor(random() * 5), tickets.length - next);
    const group = tickets.slice(next, next + size);
    next += size;
    groups++;

    // Wait until this group's arrival time. We schedule against the clock (not "sleep, then sleep")
    // so small delays don't pile up and drift.
    const wait = scheduledAt - (Date.now() - startTime);
    if (wait > 0) await sleep(wait);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${elapsed.padStart(6)}s] +${size} ticket(s): ${group.map((t) => '#' + t.id).join(', ')}`);

    for (const ticket of group) {
      const sentAt = Date.now();
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);

      // Start the request but do NOT await it here (that would hold up the next arrival).
      // `.then(...)` runs a function when the Promise finishes; it prints the result as soon as it is known.
      pending.push(
        processTicket(ticket).then((row) => {
          inFlight--;
          console.log(`           #${row.id} -> ${row.queue} [${row.reason}] ${Date.now() - sentAt}ms`);
          return row;
        }),
      );
    }

    scheduledAt += 100 + Math.floor(random() * 4900);   // next group in 100 ms to 5 s
  }

  const rows = await Promise.all(pending);   // all arrivals sent; now wait for the last answers
  return { rows, groups, peakInFlight };
}

// BENCHMARK METRICS
// Sort a copy of the numbers and pick the value at a given position, e.g. 0.95 = the 95th percentile.
// `[...values]` makes a copy so the original isn't changed; `(a, b) => a - b` sorts numbers properly.
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
const average = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

// RUN whichever path was chosen.
// `modeMetrics` holds the numbers that only make sense for that path.
let rows: Row[];
let modeMetrics: Record<string, number>;

if (MODE === 'batch') {
  const batchSize = NUMBER_ARG || tickets.length;   // no argument = everything in one batch
  const result = await runBatch(batchSize);
  rows = result.rows;
  modeMetrics = {
    batchSize,
    batches: result.batchTimes.length,
    avgBatchSeconds: Number((average(result.batchTimes) / 1000).toFixed(2)),
    slowestBatchSeconds: Number((Math.max(...result.batchTimes) / 1000).toFixed(2)),
  };
} else {
  console.log(`Real-time simulation (seed ${SEED}): groups of 1-5 tickets every 100 ms - 5 s\n`);
  const result = await runRealtime(SEED);
  rows = result.rows;
  modeMetrics = { seed: SEED, arrivalGroups: result.groups, peakInFlight: result.peakInFlight };
}

const totalSeconds = (Date.now() - startTime) / 1000;
console.log(`\nClassified ${rows.length} tickets in ${totalSeconds.toFixed(1)}s (${MODE})\n`);

const metrics = {
  mode: MODE,
  maxRetries: MAX_RETRIES ?? 'default (2)',   // `a ?? b` = a, unless a is undefined, then b
  tickets: rows.length,
  errors: rows.filter((r) => r.queue === 'error').length,
  totalSeconds: Number(totalSeconds.toFixed(2)),
  ticketsPerSecond: Number((rows.length / totalSeconds).toFixed(1)),
  ...modeMetrics,   // copy in the numbers specific to the chosen path
  ticketMs: {
    min: Math.min(...ticketTimes),
    average: Math.round(average(ticketTimes)),
    median: percentile(ticketTimes, 0.5),
    p95: percentile(ticketTimes, 0.95),
    p99: percentile(ticketTimes, 0.99),
    max: Math.max(...ticketTimes),
  },
};

// COMPLETION TIMELINE: do answers trickle in steadily, or arrive in bursts?
// Count how many tickets finished in each second of the run.
// `Array.from({ length: n }, () => 0)` makes a list of n zeros (Python: [0] * n).
const lastSecond = Math.floor(Math.max(...finishTimes) / 1000);
const completionsPerSecond = Array.from({ length: lastSecond + 1 }, () => 0);
for (const t of finishTimes) {
  completionsPerSecond[Math.floor(t / 1000)]++;   // `++` adds 1 (Python: += 1)
}

// The time (in seconds since the start) by which 10%, 50%, 90% and 100% of tickets were done.
const doneBySeconds = Object.fromEntries(
  [0.1, 0.5, 0.9, 1].map((p) => [`${p * 100}%`, Number((percentile(finishTimes, Math.min(p, 0.9999)) / 1000).toFixed(1))]),
);

console.log('Metrics:', JSON.stringify({ ...metrics, doneBySeconds }));

// The per-second histogram is only interesting for the batch path (a real-time run is hundreds of seconds long).
if (MODE === 'batch') {
  console.log('Completions per second:');
  const scale = Math.max(...completionsPerSecond) / 40;   // so the longest bar is 40 characters
  completionsPerSecond.forEach((count, second) => {
    console.log(`${String(second).padStart(3)}s | ${'#'.repeat(Math.round(count / scale))} ${count}`);
  });
}

// Add a suffix when retries were changed, so these results don't overwrite the default-settings ones.
const retriesSuffix = MAX_RETRIES === undefined ? '' : `-retries${MAX_RETRIES}`;
const metricsName =
  (MODE === 'batch' ? `metrics-batch-${modeMetrics.batchSize}` : `metrics-realtime-${rows.length}`) + `${retriesSuffix}.json`;
await writeFile(metricsName, JSON.stringify({ ...metrics, doneBySeconds, completionsPerSecond }, null, 2));

// console.table draws a grid from an array of objects. Keys become column names.
// `rows.slice(0, 20)` takes the first 20 items (Python: rows[:20]). Everything is still saved to routed.json.
const SHOW_COUNT = 20;
console.table(rows.slice(0, SHOW_COUNT));
if (rows.length > SHOW_COUNT) {
  console.log(`(showing the first ${SHOW_COUNT} of ${rows.length} tickets)`);
}

// Group by queue. `Record<string, Row[]>` is a dict whose keys are strings and values are lists of Rows
// (Python: dict[str, list[Row]]).
const byQueue: Record<string, Row[]> = {};
for (const row of rows) {
  if (!byQueue[row.queue]) {
    byQueue[row.queue] = [];   // first time we see this queue, start an empty list
  }
  byQueue[row.queue].push(row);
}

// Object.entries turns a dict into [key, value] pairs (Python: dict.items()).
// `[queue, items]` unpacks each pair, just like `for queue, items in ...` in Python.
console.log('\nBy queue:');
for (const [queue, items] of Object.entries(byQueue)) {
  console.log(`  ${queue}: ${items.length} ticket(s) -> ids ${items.map((r) => r.id).join(', ')}`);
}

// Save the grouped results to a file.
// JSON.stringify turns objects into JSON text (Python: json.dumps).
// `null, 2` means "no filter, indent by 2 spaces" so the file is readable.
await writeFile('routed.json', JSON.stringify(byQueue, null, 2));
console.log(`\nSaved results to routed.json and ${metricsName}`);
