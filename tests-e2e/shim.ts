export let db: any;
export function setDb(d: any) { db = d; }
export const BOOTSTRAPPED_ADMIN_EMAILS = ['afnan12saad@gmail.com'];
export enum OperationType { CREATE='create', UPDATE='update', DELETE='delete', LIST='list', GET='get', WRITE='write' }
export function handleFirestoreError(err: unknown, op: string, path: string | null): never { throw err; }
export const auth: any = null;
