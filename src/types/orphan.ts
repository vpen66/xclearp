/** Orphan file types for residual file cleanup */

export interface OrphanGroup {
  app_name: string;
  base_path: string;
  total_size: number;
  file_count: number;
  category: string;
  last_modified: number | null;
  paths: string[];
}

export interface OrphanDeleteResult {
  deleted_count: number;
  failed_count: number;
  freed_bytes: number;
  errors: string[];
}
