import writeFileAtomic from 'write-file-atomic'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Write content all-or-nothing: temp + fsync + rename. Never in-place. */
export async function atomicWrite(absPath: string, content: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true })
  await writeFileAtomic(absPath, content, { encoding: 'utf8', fsync: true })
}

/** Read UTF-8, or null if the file does not exist. */
export async function readFileOrNull(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}
