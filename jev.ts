import { experimental_evaluate as evaluate } from 'ai';

// A minimal JEV example: one message (the "state") and three questions, one of each type.
// Run it with:  npm run example
const result = await evaluate({
  model: 'typesafe-ai/jev',
  state: 'My order never arrived and this is the third time I have asked for a refund!',
  questions: {
    // boolean: the probability that the answer is "yes"
    refundRequested: {
      type: 'boolean',
      instructions: 'Is the customer asking for a refund?',
    },
    // choice: pick exactly one of the options
    category: {
      type: 'choice',
      instructions: 'Which category does this support case belong to?',
      criteria: { billing: null, shipping: null, other: null },
    },
    // score: a rating on an ordered scale (0 = Low, 1 = Medium, 2 = High)
    urgency: {
      type: 'score',
      instructions: 'How urgent is this case?',
      criteria: ['Low', 'Medium', 'High'],
    },
  },
});

console.log(result.answers);
