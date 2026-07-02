/** Group types matching Rust RuleGroup struct */

import type { CleanRule } from "./rules";

export interface RuleGroup {
  id: string;
  name: string;
  description: string;
  icon: string;
  rules: CleanRule[];
  default_enabled: boolean;
}
