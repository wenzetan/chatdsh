/** PostgreSQL 存储组合包：补丁层把会话持久化行切到 Postgres 后端。 */
export const PATCH_FILE = './cordis.patch.yml';
export const STORAGE_ROWS = ['session-persistence-postgres'] as const;
