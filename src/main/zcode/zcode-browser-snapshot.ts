/**
 * The zcode snapshot contract, mirrored locally: Orca cannot import the zcode
 * app's schemas, and the zcode server validates the JSON we return anyway.
 * Field-for-field these are browserSnapshotSchema / browserSnapshotElementSchema
 * from packages/shared/src/browser-use/snapshot.ts.
 */
export type ZcodeSnapshotElement = {
  ref: string
  tag: string
  role?: string
  name?: string
  text?: string
  value?: string
  disabled?: boolean
  checked?: boolean
  selector: string
  xpath: string
  rect: { x: number; y: number; width: number; height: number }
  inViewport: boolean
  parentRef?: string
  framePath?: string
  attributes?: Record<string, string>
}

export type ZcodeSnapshotDomNode = {
  tag: string
  depth: number
  inViewport: boolean
  ref?: string
  role?: string
  name?: string
  text?: string
  attributes?: Record<string, string>
}

export type ZcodeSnapshot = {
  url: string
  title: string
  dom?: ZcodeSnapshotDomNode[]
  domTruncated?: boolean
  elements: ZcodeSnapshotElement[]
  truncated: boolean
  /** Collector extras getState reads; not part of the wire snapshot schema. */
  scrollX?: number
  scrollY?: number
  viewportWidth?: number
  viewportHeight?: number
}

export type ZcodePageState = {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  scrollX?: number
  scrollY?: number
  viewportWidth?: number
  viewportHeight?: number
}

export const ZCODE_SNAPSHOT_DEFAULT_MAX_ELEMENTS = 200
const MAX_DOM_NODES = 300

/**
 * In-page collector, run through browserEval (CDP Runtime.evaluate). The body
 * mirrors the reference collector in the zcode CLI's managed CDP adapter
 * (adapters/src/browser/snapshot.ts): action elements get e1..eN refs in DOM
 * order, a bounded semantic dom tree rides along, and per-element CSS selectors
 * are minted so later actions can address a ref without element handles.
 */
const collectorBody = String.raw`
const actionSelector = "a[href],button,input,textarea,select,[role],[onclick],[tabindex],summary,label,[contenteditable]";
const domSelector = "body,main,nav,header,footer,aside,section,article,h1,h2,h3,h4,h5,h6,p,ul,ol,li,dl,dt,dd,blockquote,pre,code,table,caption,thead,tbody,tfoot,tr,th,td,form,fieldset,legend,figure,figcaption,img,canvas,svg,a[href],button,input,textarea,select,option,summary,label,[role],[aria-label],[contenteditable]";
const refElements = [];
const reverseRefs = new WeakMap();
const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
const hidden = (element) => {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || (rect.width <= 0 && rect.height <= 0);
};
const text = (value, max) => String(value == null ? "" : value).trim().replace(/\s+/g, " ").slice(0, max);
const implicitRole = (element, tag) => {
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag !== "input") return "";
  const type = (element.getAttribute("type") || "text").toLowerCase();
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (type === "button" || type === "submit" || type === "reset") return "button";
  if (type === "search") return "searchbox";
  return "textbox";
};
const accessibleName = (element) => text(
  element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("placeholder") || element.innerText || element.textContent, 120);
const attributes = (element) => {
  const result = {};
  for (const key of ["id","href","name","type","placeholder","title","alt","role","aria-label","data-testid","data-test","data-qa"]) {
    const value = text(element.getAttribute(key), 240);
    if (value) result[key] = value;
  }
  return result;
};
const selector = (element) => {
  if (element.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(element.id)) return "#" + element.id;
  const parts = [];
  let current = element;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const tag = current.tagName.toLowerCase();
    const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((c) => c.tagName === current.tagName) : [];
    parts.unshift(tag + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")");
    current = current.parentElement;
  }
  return parts.join(" > ");
};
const xpath = (element) => {
  const parts = [];
  let current = element;
  while (current) {
    const tag = current.tagName.toLowerCase();
    const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((c) => c.tagName === current.tagName) : [];
    parts.unshift(tag + "[" + (siblings.indexOf(current) + 1) + "]");
    current = current.parentElement;
  }
  return "/" + parts.join("/");
};
const inViewport = (rect) => rect.top < viewportHeight && rect.bottom > 0 && rect.left < viewportWidth && rect.right > 0;
const actionNodes = Array.from(document.querySelectorAll(actionSelector)).filter((element) => options.includeHidden || !hidden(element));
const elements = actionNodes.slice(0, options.maxElements).map((element, index) => {
  const ref = "e" + (index + 1);
  refElements.push(element);
  reverseRefs.set(element, ref);
  const rect = element.getBoundingClientRect();
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role") || implicitRole(element, tag);
  const name = accessibleName(element);
  const elementText = text(element.innerText, 100);
  const attrs = attributes(element);
  const value = "value" in element ? text(String(element.value), 240) : "";
  let parent = element.parentElement;
  let parentRef;
  while (parent && !parentRef) {
    parentRef = reverseRefs.get(parent);
    parent = parent.parentElement;
  }
  const out = {
    ref, tag,
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...(elementText ? { text: elementText } : {}),
    ...(value ? { value } : {}),
    ...("disabled" in element && element.disabled ? { disabled: true } : {}),
    ...("checked" in element ? { checked: Boolean(element.checked) } : {}),
    selector: selector(element),
    xpath: xpath(element),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    inViewport: inViewport(rect),
    ...(parentRef ? { parentRef } : {}),
    ...(Object.keys(attrs).length > 0 ? { attributes: attrs } : {})
  };
  return out;
});
const domNodes = Array.from(document.querySelectorAll(domSelector)).filter((element) => options.includeHidden || !hidden(element));
const dom = domNodes.slice(0, options.maxDomNodes).map((element) => {
  const rect = element.getBoundingClientRect();
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role") || implicitRole(element, tag);
  const name = accessibleName(element);
  const semanticText = /^(h[1-6]|p|li|dt|dd|blockquote|pre|code|caption|th|td|label|summary|button|a|option|legend|figcaption)$/.test(tag) ? text(element.innerText || element.textContent, 300) : "";
  let depth = 0;
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) depth += 1;
  const ref = reverseRefs.get(element);
  const attrs = attributes(element);
  return {
    tag, depth,
    inViewport: inViewport(rect),
    ...(ref ? { ref } : {}),
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...(semanticText ? { text: semanticText } : {}),
    ...(Object.keys(attrs).length > 0 ? { attributes: attrs } : {})
  };
});
return {
  url: location.href,
  title: document.title,
  elements,
  truncated: actionNodes.length > options.maxElements,
  dom,
  domTruncated: domNodes.length > options.maxDomNodes,
  scrollX: Math.round(window.scrollX || 0),
  scrollY: Math.round(window.scrollY || 0),
  viewportWidth,
  viewportHeight
};`

export function zcodeSnapshotExpression(input: {
  maxElements?: number
  includeHidden?: boolean
}): string {
  const options = {
    includeHidden: input.includeHidden === true,
    maxDomNodes: MAX_DOM_NODES,
    maxElements: Math.max(1, Math.floor(input.maxElements ?? ZCODE_SNAPSHOT_DEFAULT_MAX_ELEMENTS))
  }
  return `((options) => {${collectorBody}})(${JSON.stringify(options)})`
}

/** browserEval returns objects as JSON strings; anything else is not a snapshot. */
export function parseZcodeSnapshotEval(result: string): ZcodeSnapshot | null {
  try {
    const parsed = JSON.parse(result) as ZcodeSnapshot
    if (
      typeof parsed?.url !== 'string' ||
      typeof parsed?.title !== 'string' ||
      !Array.isArray(parsed?.elements)
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}
