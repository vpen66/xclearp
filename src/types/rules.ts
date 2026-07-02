/** Rule types matching Rust CleanRule struct */

export type RiskLevel = "Safe" | "Medium" | "High";

export interface CleanRule {
  id: string;
  name: string;
  group: string;
  description: string;
  platforms: string[];
  paths: string[];
  file_patterns: string[];
  exclude_patterns: string[];
  min_age_hours: number | null;
  max_size_mb: number | null;
  risk_level: RiskLevel;
  enabled: boolean;
}
