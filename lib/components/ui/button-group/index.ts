import Root from "./button-group.svelte";
import Text from "./button-group-text.svelte";
import Separator from "./button-group-separator.svelte";

export {
	Root,
	Text,
	Separator,
	//
	Root as ButtonGroup,
	Text as ButtonGroupText,
	Separator as ButtonGroupSeparator,
};

export { buttonGroupVariants } from "./variants.js";
export type { ButtonGroupOrientation } from "./variants.js";
