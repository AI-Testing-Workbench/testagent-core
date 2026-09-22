import { ComponentProps, createUniqueId } from "solid-js"

// testagent_change start - TestAgent cloud-mode mark (robot face with warm clouds)
const CLOUD_PATH =
  "M-15.6 5.4c-2.4 0-4.4-1.8-4.4-4.0 0-1.9 1.5-3.6 3.5-4.0 .4-2.7 3.0-4.8 6.2-4.8 1.2 0 2.3 .3 3.3 .9 1.4-2.1 3.9-3.5 6.8-3.5 3.6 0 6.6 2.1 7.4 5.0 3.4 0 6.0 2.4 6.0 5.3 0 2.8-2.5 5.0-5.6 5.0H-15.6z"

const CloudArt = (props: { id: string }) => {
  const uid = (suffix: string) => `${props.id}-${suffix}`
  return (
    <>
      <defs>
        <linearGradient id={uid("rg")} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#4fc3f7" />
          <stop offset="50%" stop-color="#2979ff" />
          <stop offset="100%" stop-color="#69f0ae" />
        </linearGradient>
        <linearGradient id={uid("back")} x1="0" y1="-9" x2="0" y2="9" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#FFE3CE" />
          <stop offset="0.5" stop-color="#FFD3B3" />
          <stop offset="1" stop-color="#FFB89A" />
        </linearGradient>
        <linearGradient id={uid("front")} x1="0" y1="-9" x2="0" y2="9" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#FFF1CE" />
          <stop offset="0.5" stop-color="#FCE3B0" />
          <stop offset="1" stop-color="#F5C374" />
        </linearGradient>
        <radialGradient id={uid("hi")} cx="32%" cy="24%" r="60%">
          <stop offset="0" stop-color="#ffffff" stop-opacity=".62" />
          <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
        </radialGradient>
        <filter id={uid("shadow")} x="-80%" y="-120%" width="260%" height="340%">
          <feDropShadow dx="0" dy="0.9" stdDeviation="1.05" flood-color="#A2603C" flood-opacity=".18" />
        </filter>
      </defs>
      <g transform="translate(11.0 21.41) scale(0.85)" filter={`url(#${uid("shadow")})`}>
        <g class="cm-cloud-bob">
          <path
            d={CLOUD_PATH}
            fill={`url(#${uid("back")})`}
            stroke="#E69E78"
            stroke-width="0.55"
            stroke-opacity="0.32"
            stroke-linejoin="round"
          />
          <ellipse cx="-3.5" cy="-4.5" rx="6" ry="2.8" fill={`url(#${uid("hi")})`} opacity=".48" />
        </g>
      </g>
      <circle cx="12" cy="12" r="12" fill="#e8f4ff" />
      <circle cx="12" cy="12" r="12.75" fill="none" stroke={`url(#${uid("rg")})`} stroke-width="1.5" />
      <ellipse cx="8" cy="9.33" rx="1.63" ry="2.62" fill="#2979ff" />
      <ellipse cx="16" cy="9.33" rx="1.63" ry="2.62" fill="#2979ff" />
      <g transform="translate(17.88 21.41) scale(0.85)" filter={`url(#${uid("shadow")})`}>
        <g class="cm-cloud-bob cm-cloud-front">
          <path
            d={CLOUD_PATH}
            fill={`url(#${uid("front")})`}
            stroke="#D9A04F"
            stroke-width="0.55"
            stroke-opacity="0.36"
            stroke-linejoin="round"
          />
          <ellipse cx="-3" cy="-4" rx="5.2" ry="2.4" fill={`url(#${uid("hi")})`} opacity=".55" />
        </g>
      </g>
    </>
  )
}

export const Mark = (props: { class?: string; style?: any }) => {
  const id = `testagent-cloud-${createUniqueId()}`
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="-7 -6 38 38"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={props.style}
      role="img"
      aria-label="TestAgent"
    >
      <CloudArt id={id} />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  const id = `testagent-cloud-${createUniqueId()}`
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="-7 -6 38 38"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="TestAgent"
    >
      <CloudArt id={id} />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        gap: "1rem",
        "white-space": "nowrap",
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 176 42"
        fill="none"
        classList={{ [props.class ?? ""]: !!props.class }}
        style={{ "min-width": "0" }}
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
      <Mark class="w-28" style={{ "flex-shrink": "0" }} />
    </div>
  )
}
// testagent_change end
