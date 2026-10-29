// Minimal stand-ins for the shadcn/radix components the Base44 builder imported
// (button, input, textarea, dialog, select). Same props, native elements, no radix.
import React, { Children, isValidElement } from 'react';
import { cn } from './utils';

const BUTTON = {
  default: 'bg-foreground text-background hover:bg-foreground/90',
  outline: 'border border-border bg-transparent hover:bg-muted',
  ghost: 'bg-transparent hover:bg-muted',
  secondary: 'bg-muted text-foreground hover:bg-muted/80',
  destructive: 'bg-destructive text-white',
};
const SIZE = { default: 'h-9 px-4', sm: 'h-8 px-3 text-xs', lg: 'h-10 px-6', icon: 'h-9 w-9' };

export const Button = React.forwardRef(function Button({ className, variant = 'default', size = 'default', asChild: _asChild, ...props }, ref) {
  return (
    <button
      ref={ref}
      className={cn('inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50', BUTTON[variant] || BUTTON.default, SIZE[size] || SIZE.default, className)}
      {...props}
    />
  );
});

export const Input = React.forwardRef(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn('flex h-9 w-full rounded-md border border-border bg-transparent px-3 py-1 text-sm', className)} {...props} />;
});

export const Textarea = React.forwardRef(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn('flex min-h-[60px] w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm', className)} {...props} />;
});

export function Dialog({ open, onOpenChange, children }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onOpenChange?.(false); }}>
      {children}
    </div>
  );
}
export function DialogContent({ className, children }) {
  return <div role="dialog" className={cn('w-full max-w-lg rounded-lg border border-border bg-background p-5 shadow-lg', className)}>{children}</div>;
}
export const DialogHeader = ({ className, ...p }) => <div className={cn('mb-3 flex flex-col gap-1', className)} {...p} />;
export const DialogFooter = ({ className, ...p }) => <div className={cn('mt-4 flex justify-end gap-2', className)} {...p} />;
export const DialogTitle = ({ className, ...p }) => <h2 className={cn('text-base font-semibold', className)} {...p} />;
export const DialogDescription = ({ className, ...p }) => <p className={cn('text-sm text-muted-foreground', className)} {...p} />;

// Select: the shadcn tree <Select><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem/>...
// collapses into one native <select>.
export function SelectTrigger() { return null; }
export function SelectValue() { return null; }
export function SelectContent() { return null; }
export function SelectItem() { return null; }

function collect(children, out) {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === SelectItem) out.items.push(child.props);
    else if (child.type === SelectTrigger) { out.trigger = child.props; collect(child.props.children, out); }
    else if (child.type === SelectValue) out.placeholder = child.props.placeholder;
    else collect(child.props.children, out);
  });
  return out;
}

export function Select({ value, onValueChange, disabled, children }) {
  const { items, trigger, placeholder } = collect(children, { items: [], trigger: null, placeholder: undefined });
  return (
    <select
      className={cn('flex h-9 w-full rounded-md border border-border bg-transparent px-2 text-sm', trigger?.className)}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {placeholder !== undefined && <option value="" disabled>{placeholder}</option>}
      {items.map((item) => <option key={item.value} value={item.value}>{item.children}</option>)}
    </select>
  );
}
