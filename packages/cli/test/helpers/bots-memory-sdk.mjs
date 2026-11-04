// These are service contracts, not a memory implementation or a model response.
// The original definitions/execute functions are returned unchanged.
export const defineTool = definition => definition;
export class HarnessError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
export let modelAttempts = 0;
export function refuseModel() {
  modelAttempts++;
  throw new Error('Memory contract fixture forbids model/provider calls');
}
export class BlockAssembler { constructor() { refuseModel(); } }
export const createUserMessage = value => value;
export const checkShownView = () => { throw new Error('Deep View is outside this memory fixture'); };
export const showViewDescription = () => 'Unavailable in memory contract fixture';
export const showViewParameters = {};
