import { startUploader } from './attachments';
import { startReconciler } from './runtime';

/** Background wiki work started shortly after app load (lazy chunk). */
export function start(): void {
  startReconciler();
  startUploader();
}
