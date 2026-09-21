import { z } from "zod";

/**
 * Il nome diventa il filename che il CLI scrive nella repository, quindi si
 * valida invece di crederci: un trattino iniziale verrebbe letto come flag, e
 * tutto cio' che non e' in questo alfabeto puo' uscire dalla cartella delle
 * migrazioni. E' lo stesso alfabeto che il CLI genera da solo.
 *
 * Vive qui e non solo nell'executor perche' un payload sbagliato deve tornare
 * al chiamante come invalid_input al submit, non come errore generico a meta'
 * esecuzione quando il job e' gia' in coda.
 */
export const MigrationDiffPayloadSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-z0-9_]+$/,
      "name must use only lowercase letters, digits and underscores"
    )
});

export function parseMigrationDiffPayload(payload: unknown): string {
  return MigrationDiffPayloadSchema.parse(payload).name;
}
