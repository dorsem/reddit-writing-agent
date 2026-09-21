// Synthetic, offline fixtures. No account, network or language model is used.
export function demoReddit() {
  const post = { id: 'demo1', name: 't3_demo1', subreddit: 'writing_lab', author: 'fictional_reader', title: 'How do you keep a scene focused?', selftext: 'My scenes tend to wander. What helps you revise?', created_utc: Date.now() / 1000 };
  return {
    clientId: 'offline-demo',
    me: async () => ({ id: 'synthetic-agent', name: 'synthetic_agent' }),
    rules: async () => ({ rules: [{ title: 'Be constructive', text: 'Discuss writing; automated assistance is welcome in this synthetic example.', kind: 'all' }], description: '', publicDescription: '', submitText: '', submissionType: 'any', about: { display_name: 'writing_lab', subreddit_type: 'public' } }),
    recent: async () => [post], info: async () => post,
    context: async () => ['Try identifying the decision that changes the scene.'],
    submit: async () => { throw new Error('Offline demo cannot publish.'); }
  };
}
export const demoModel = async () => ({ action: 'comment', text: 'Try writing one sentence about what changes by the end of the scene. Then mark each paragraph that contributes to that change. A paragraph can slow the action on purpose, but it should still affect what the reader understands or expects.' });
