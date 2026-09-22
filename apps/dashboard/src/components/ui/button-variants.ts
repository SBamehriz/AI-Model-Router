import { cva } from 'class-variance-authority';

/**
 * The default variant carries no background utility on purpose. Its gradient
 * lives in index.css beside the other brand surfaces, so there is one place to
 * change it.
 *
 * The focus ring is solid. At half opacity it composited to between 2.2 and
 * 2.7 to one against the surfaces it is drawn on, under the 3:1 a focus
 * indicator needs, and it was the weaker of the two indicators this interface
 * uses: everything that is not a button gets the solid outline from index.css
 * and was already fine.
 */
export const buttonVariants = cva(
  "inline-flex max-w-full items-center justify-center gap-2 whitespace-normal rounded-md text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: 'text-primary-foreground shadow-sm hover:shadow-md',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'min-h-11 px-4 py-2 active:scale-[0.98]',
        sm: 'min-h-9 rounded-md gap-1.5 px-3 py-1.5 active:scale-[0.98]',
        lg: 'min-h-12 rounded-md px-6 py-2 active:scale-[0.98]',
        // The same press feedback as every other size. The refresh and theme
        // controls are among the most clicked things here and were the only
        // buttons that did not answer a press.
        icon: 'size-11 active:scale-[0.98]',
        'icon-sm': 'size-8 active:scale-[0.98]',
        'icon-lg': 'size-10 active:scale-[0.98]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);
