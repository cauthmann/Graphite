import { DialogState } from "@/state/dialog";
import { FullscreenState } from "@/state/fullscreen";
import { DocumentsState } from "@/state/documents";
import { EditorState } from "@/state/wasm-loader";

type EventName = keyof HTMLElementEventMap | keyof WindowEventHandlersEventMap;
interface EventListenerTarget {
	addEventListener: typeof window.addEventListener;
	removeEventListener: typeof window.removeEventListener;
}

export type InputManager = ReturnType<typeof createInputManager>;
export function createInputManager(container: HTMLElement, fullscreen: FullscreenState, dialog: DialogState, editor: EditorState, document: DocumentsState) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const listeners: { target: EventListenerTarget; eventName: EventName; action: (event: any) => void; options?: boolean | AddEventListenerOptions }[] = [
		{ target: window, eventName: "resize", action: () => onWindowResize(container) },
		{ target: window, eventName: "mousemove", action: (e) => onMouseMove(e) },
		{ target: window, eventName: "beforeunload", action: (e) => onBeforeUnload(e) },
		{ target: container, eventName: "contextmenu", action: (e) => e.preventDefault() },
		{ target: container, eventName: "keyup", action: (e) => onKeyUp(e) },
		{ target: container, eventName: "keydown", action: (e) => onKeyDown(e) },
		{ target: container, eventName: "mousedown", action: (e) => onMouseDown(e) },
		{ target: container, eventName: "mouseup", action: (e) => onMouseUp(e) },
		{ target: container, eventName: "wheel", action: (e) => onMouseScroll(e), options: { passive: true } },
	];

	let viewportMouseInteractionOngoing = false;

	const removeListeners = () => {
		listeners.forEach(({ target, eventName, action }) => target.removeEventListener(eventName, action));
	};

	const shouldRedirectKeyboardEventToBackend = (e: KeyboardEvent): boolean => {
		// Don't redirect user input from text entry into HTML elements
		const target = e.target as HTMLElement;
		if (target.nodeName === "INPUT" || target.nodeName === "TEXTAREA" || target.isContentEditable) return false;

		// Don't redirect when a modal is covering the workspace
		if (dialog.dialogIsVisible()) return false;

		// Don't redirect a fullscreen request
		if (e.key.toLowerCase() === "f11" && e.type === "keydown" && !e.repeat) {
			e.preventDefault();
			fullscreen.toggleFullscreen();
			return false;
		}

		// Don't redirect a reload request
		if (e.key.toLowerCase() === "f5") return false;

		// Don't redirect debugging tools
		if (e.key.toLowerCase() === "f12") return false;
		if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") return false;
		if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "i") return false;
		if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "j") return false;

		// Redirect to the backend
		return true;
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (shouldRedirectKeyboardEventToBackend(e)) {
			e.preventDefault();
			const modifiers = makeModifiersBitfield(e);
			editor.instance.on_key_down(e.key, modifiers);
			return;
		}

		if (dialog.dialogIsVisible()) {
			if (e.key === "Escape") dialog.dismissDialog();
			if (e.key === "Enter") {
				dialog.submitDialog();

				// Prevent the Enter key from acting like a click on the last clicked button, which might reopen the dialog
				e.preventDefault();
			}
		}
	};

	const onKeyUp = (e: KeyboardEvent) => {
		if (shouldRedirectKeyboardEventToBackend(e)) {
			e.preventDefault();
			const modifiers = makeModifiersBitfield(e);
			editor.instance.on_key_up(e.key, modifiers);
		}
	};

	const onMouseMove = (e: MouseEvent) => {
		if (!e.buttons) viewportMouseInteractionOngoing = false;

		const modifiers = makeModifiersBitfield(e);
		editor.instance.on_mouse_move(e.clientX, e.clientY, e.buttons, modifiers);
	};

	const onMouseDown = (e: MouseEvent) => {
		const target = e.target && (e.target as HTMLElement);
		const inCanvas = target && target.closest(".canvas");
		const inDialog = target && target.closest(".dialog-modal .floating-menu-content");

		// Block middle mouse button auto-scroll mode
		if (e.button === 1) e.preventDefault();

		if (dialog.dialogIsVisible() && !inDialog) {
			dialog.dismissDialog();
			e.preventDefault();
			e.stopPropagation();
		}

		if (inCanvas) viewportMouseInteractionOngoing = true;

		if (viewportMouseInteractionOngoing) {
			const modifiers = makeModifiersBitfield(e);
			editor.instance.on_mouse_down(e.clientX, e.clientY, e.buttons, modifiers);
		}
	};

	const onMouseUp = (e: MouseEvent) => {
		if (!e.buttons) viewportMouseInteractionOngoing = false;

		const modifiers = makeModifiersBitfield(e);
		editor.instance.on_mouse_up(e.clientX, e.clientY, e.buttons, modifiers);
	};

	const onMouseScroll = (e: WheelEvent) => {
		const target = e.target && (e.target as HTMLElement);
		const inCanvas = target && target.closest(".canvas");

		const horizontalScrollableElement = e.target instanceof Element && e.target.closest(".scrollable-x");
		if (horizontalScrollableElement && e.deltaY !== 0) {
			horizontalScrollableElement.scrollTo(horizontalScrollableElement.scrollLeft + e.deltaY, 0);
			return;
		}

		if (inCanvas) {
			const modifiers = makeModifiersBitfield(e);
			editor.instance.on_mouse_scroll(e.clientX, e.clientY, e.buttons, e.deltaX, e.deltaY, e.deltaZ, modifiers);
		}
	};

	const onWindowResize = (container: Element) => {
		const viewports = Array.from(container.querySelectorAll(".canvas"));
		const boundsOfViewports = viewports.map((canvas) => {
			const bounds = canvas.getBoundingClientRect();
			return [bounds.left, bounds.top, bounds.right, bounds.bottom];
		});

		const flattened = boundsOfViewports.flat();
		const data = Float64Array.from(flattened);

		if (boundsOfViewports.length > 0) editor.instance.bounds_of_viewports(data);
	};

	const onBeforeUnload = (event: BeforeUnloadEvent) => {
		const allDocumentsSaved = document.state.documents.reduce((acc, doc) => acc && doc.isSaved, true);
		if (!allDocumentsSaved) {
			event.returnValue = "Unsaved work will be lost if the web browser tab is closed. Close anyway?";
			event.preventDefault();
		}
	};

	// Run on creation
	listeners.forEach(({ target, eventName, action, options }) => target.addEventListener(eventName, action, options));
	onWindowResize(container);

	return {
		removeListeners,
	};
}

export function makeModifiersBitfield(e: MouseEvent | KeyboardEvent): number {
	return Number(e.ctrlKey) | (Number(e.shiftKey) << 1) | (Number(e.altKey) << 2);
}
