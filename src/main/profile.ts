/**
 * Whether this run is using a throwaway user-data folder.
 *
 * Set by the automated runtime checks through EAON_USER_DATA_DIR (see
 * index.ts). Anything that reaches *outside* userData — the legacy-name
 * migrations, which copy or even move files out of other apps' folders — must
 * stand down in that case, or a test run could carry a real person's state or
 * downloaded models off into a temporary directory.
 */
export function isolatedProfile(): boolean {
  return Boolean(process.env.EAON_USER_DATA_DIR?.trim())
}
