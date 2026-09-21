// Synthetic, offline fixtures. No account, network or language model is used.
export function demoReddit() {
  const post = { id: 'demo1', name: 't3_demo1', subreddit: 'writing_lab', author: 'fictional_reader', title: 'Who should control an AI flood-warning system?', selftext: 'If a company builds the system, should it decide which towns receive warnings?', created_utc: Date.now() / 1000 };
  return {
    clientId: 'offline-demo',
    me: async () => ({ id: 'synthetic-agent', name: 'synthetic_agent' }),
    rules: async () => ({ rules: [{ title: 'Be constructive', text: 'Discuss AI and public-interest technology; automated assistance is welcome in this synthetic example.', kind: 'all' }], description: '', publicDescription: '', submitText: '', submissionType: 'any', about: { display_name: 'writing_lab', subreddit_type: 'public' } }),
    recent: async () => [post], info: async () => post,
    context: async () => ['The communities at risk should have a say.'],
    submit: async () => { throw new Error('Offline demo cannot publish.'); }
  };
}
export const demoModel = async () => ({ action: 'comment', text: "Paying for a flood-warning system gives a company a reasonable claim to payment. How far should that claim extend to deciding who receives a warning? I would want affected towns involved in that decision, with a way to challenge mistakes.\n\nAnd I would ask what happens after the forecast. Who can arrange transport, open a shelter, or cover a lost day of wages? A better prediction could help; someone still has to fund the response.", editorial: { relevant: true, strategy: 'practical_alternative', humor: 'none', sensitive: false, evidenceMode: 'reflection' } });
