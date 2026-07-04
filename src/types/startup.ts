/** Types for startup item management */

export interface StartupItem {
  name: string;
  command: string;
  source: string;
  platform: string;
  enabled: boolean;
  item_type: string;
  user_level: string;
}
