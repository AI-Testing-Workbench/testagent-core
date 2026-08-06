import { ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 16H4V8H12V16Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-o" d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M10 28H28V100H10V28Z" fill="var(--icon-weak-base)" />
      <path d="M0 0H38V28H28V100H10V28H0V0Z" fill="var(--icon-strong-base)" />
      <path d="M52 28H70V56H52V28Z" fill="var(--icon-base)" />
      <path d="M42 0H80V28H70V56H80V100H42V56H52V28H42V0Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 200 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <text
        y="32"
        font-family="ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, monospace"
        font-size="32"
        font-weight="800"
        fill="var(--icon-strong-base)"
      >
        TestAgent
      </text>
    </svg>
  )
}
