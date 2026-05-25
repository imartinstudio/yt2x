export const queryAllDeep = (root: ParentNode, selector: string): Element[] => {
  const results: Element[] = [];
  const visit = (node: ParentNode): void => {
    results.push(...node.querySelectorAll(selector));
    for (const element of node.querySelectorAll("*")) {
      if (element.shadowRoot instanceof ShadowRoot) visit(element.shadowRoot);
    }
  };
  visit(root);
  return results;
};
