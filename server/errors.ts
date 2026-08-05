/**
 * The one error the API answers 400 for.
 *
 * Its own module because `server/sessions.ts` needs to throw it and
 * `server/game.ts` needs to import that file — a cycle if the class lived in
 * either. SPEC §6.1: the message is a sentence that states its own fix, and it
 * is shown to the player as written.
 */
export class GameError extends Error {}
