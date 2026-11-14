import { z } from 'zod';

/** Field helpers shared by collection schemas. */

export const nameField = z.string().trim().min(1).max(200);
export const shortTextField = z.string().max(200);
export const notesField = z.string().max(100_000);
export const longTextField = z.string().max(2_000_000);
export const urlField = z.url().max(4096);
export const refField = z.uuid();
export const nullableRef = z.uuid().nullable().default(null);
export const tagField = z.string().trim().min(1).max(64);
