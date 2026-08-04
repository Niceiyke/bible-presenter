export interface TimerData {
  timer_type: "countdown" | "countup" | "clock";
  duration_secs?: number;
  label?: string;
  started_at?: number;
}
