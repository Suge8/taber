export type ToastTone = 'success' | 'error' | 'info';

export type ToastInput = {
  tone: ToastTone;
  text: string;
};

export type ToastNotice = ToastInput & {
  id: number;
};

export type Notify = (notice: ToastInput) => void;
