// Content script functions — injected on-demand via chrome.scripting.executeScript.
// Each function is self-contained and runs in the page's DOM context.

export function getPageText(): string {
  return document.body.innerText;
}

export function getPageHtml(selector?: string): string {
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    return el.outerHTML;
  }
  return document.documentElement.outerHTML;
}

export function getPageTitle(): string {
  return document.title;
}

export function getLinks(): Array<{ text: string; href: string }> {
  const links = Array.from(document.querySelectorAll("a[href]"));
  return links.map((a) => ({
    text: (a as HTMLAnchorElement).innerText.trim().slice(0, 200),
    href: (a as HTMLAnchorElement).href,
  }));
}

export function getHeadings(): Array<{ level: number; text: string }> {
  const headings = Array.from(
    document.querySelectorAll("h1, h2, h3, h4, h5, h6")
  );
  return headings.map((h) => ({
    level: parseInt(h.tagName[1], 10),
    text: (h as HTMLElement).innerText.trim().slice(0, 200),
  }));
}

export function clickElement(selector: string): { clicked: boolean } {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) throw new Error(`Element not found: ${selector}`);
  el.scrollIntoView({ behavior: "instant", block: "center" });
  el.click();
  return { clicked: true };
}

export function typeText(
  selector: string,
  text: string,
  clearFirst: boolean
): { typed: boolean } {
  const el = document.querySelector(selector) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  if (!el) throw new Error(`Element not found: ${selector}`);

  el.scrollIntoView({ behavior: "instant", block: "center" });
  el.focus();

  if (clearFirst) {
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Set value and dispatch events that React/Vue/Angular listen for
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )?.set;

  const setter =
    el instanceof HTMLTextAreaElement
      ? nativeTextAreaValueSetter
      : nativeInputValueSetter;

  if (setter) {
    setter.call(el, clearFirst ? text : el.value + text);
  } else {
    el.value = clearFirst ? text : el.value + text;
  }

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));

  return { typed: true };
}

export function selectOption(
  selector: string,
  value: string
): { selected: boolean } {
  const el = document.querySelector(selector) as HTMLSelectElement | null;
  if (!el) throw new Error(`Element not found: ${selector}`);

  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("input", { bubbles: true }));

  return { selected: true };
}

export function scrollPage(
  direction: string,
  amount?: number
): { scrolled: boolean } {
  const defaultAmount =
    direction === "up" || direction === "down"
      ? window.innerHeight
      : window.innerWidth;
  const px = amount ?? defaultAmount;

  const scrollMap: Record<string, [number, number]> = {
    up: [0, -px],
    down: [0, px],
    left: [-px, 0],
    right: [px, 0],
  };

  const [x, y] = scrollMap[direction] ?? [0, 0];
  window.scrollBy(x, y);

  return { scrolled: true };
}

export function hoverElement(selector: string): { hovered: boolean } {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) throw new Error(`Element not found: ${selector}`);

  el.scrollIntoView({ behavior: "instant", block: "center" });

  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  el.dispatchEvent(
    new MouseEvent("mouseenter", { bubbles: true, clientX: x, clientY: y })
  );
  el.dispatchEvent(
    new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y })
  );
  el.dispatchEvent(
    new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y })
  );

  return { hovered: true };
}

export function querySelectorAll(
  selector: string,
  attributes?: string[]
): Array<Record<string, unknown>> {
  const defaultAttrs = ["id", "class", "href", "src", "type", "value", "name"];
  const attrs = attributes ?? defaultAttrs;
  const elements = Array.from(document.querySelectorAll(selector)).slice(0, 50);

  return elements.map((el) => {
    const result: Record<string, unknown> = {
      tagName: el.tagName.toLowerCase(),
      text: (el as HTMLElement).innerText?.trim().slice(0, 200) ?? "",
    };

    for (const attr of attrs) {
      const val = el.getAttribute(attr);
      if (val !== null) {
        result[attr] = val;
      }
    }

    return result;
  });
}

export function evaluateJs(expression: string): unknown {
  // Use indirect eval to execute in global scope
  return (0, eval)(expression);
}

export function getFormFields(): Array<Record<string, unknown>> {
  const fields: Array<Record<string, unknown>> = [];
  const inputs = document.querySelectorAll(
    "input, textarea, select"
  );

  inputs.forEach((el) => {
    const htmlEl = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const field: Record<string, unknown> = {
      tagName: el.tagName.toLowerCase(),
      type: (el as HTMLInputElement).type ?? undefined,
      name: htmlEl.name || undefined,
      id: htmlEl.id || undefined,
      value: htmlEl.value,
    };

    // Try to find a label
    if (htmlEl.id) {
      const label = document.querySelector(`label[for="${htmlEl.id}"]`);
      if (label) {
        field.label = (label as HTMLElement).innerText.trim();
      }
    }
    if (!field.label) {
      const parentLabel = htmlEl.closest("label");
      if (parentLabel) {
        field.label = parentLabel.innerText.trim();
      }
    }

    // For select elements, include options
    if (el.tagName === "SELECT") {
      const select = el as HTMLSelectElement;
      field.options = Array.from(select.options).map((opt) => ({
        value: opt.value,
        text: opt.text,
        selected: opt.selected,
      }));
    }

    // For checkboxes/radios, include checked state
    if (
      el.tagName === "INPUT" &&
      ((el as HTMLInputElement).type === "checkbox" ||
        (el as HTMLInputElement).type === "radio")
    ) {
      field.checked = (el as HTMLInputElement).checked;
    }

    fields.push(field);
  });

  return fields;
}

export function getElementBoundingRect(
  selector: string
): { x: number; y: number; width: number; height: number } {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  const rect = el.getBoundingClientRect();
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}
