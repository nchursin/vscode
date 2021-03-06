/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IQuickPick, IQuickPickItem } from 'vs/platform/quickinput/common/quickInput';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { IQuickPickSeparator, IKeyMods, IQuickPickAcceptEvent } from 'vs/base/parts/quickinput/common/quickInput';
import { IQuickAccessProvider } from 'vs/platform/quickinput/common/quickAccess';
import { IDisposable, DisposableStore, Disposable } from 'vs/base/common/lifecycle';
import { timeout } from 'vs/base/common/async';

export enum TriggerAction {

	/**
	 * Do nothing after the button was clicked.
	 */
	NO_ACTION,

	/**
	 * Close the picker.
	 */
	CLOSE_PICKER,

	/**
	 * Update the results of the picker.
	 */
	REFRESH_PICKER
}

export interface IPickerQuickAccessItem extends IQuickPickItem {

	/**
	* A method that will be executed when the pick item is accepted from
	* the picker. The picker will close automatically before running this.
	*
	* @param keyMods the state of modifier keys when the item was accepted.
	* @param event the underlying event that caused the accept to trigger.
	*/
	accept?(keyMods: IKeyMods, event: IQuickPickAcceptEvent): void;

	/**
	 * A method that will be executed when a button of the pick item was
	 * clicked on.
	 *
	 * @param buttonIndex index of the button of the item that
	 * was clicked.
	 *
	 * @param the state of modifier keys when the button was triggered.
	 *
	 * @returns a value that indicates what should happen after the trigger
	 * which can be a `Promise` for long running operations.
	 */
	trigger?(buttonIndex: number, keyMods: IKeyMods): TriggerAction | Promise<TriggerAction>;
}

export interface IPickerQuickAccessProviderOptions {
	canAcceptInBackground?: boolean;
}

export type FastAndSlowPicksType<T> = { picks: Array<T | IQuickPickSeparator>, additionalPicks: Promise<Array<T | IQuickPickSeparator>> };

function isFastAndSlowPicksType<T>(obj: unknown): obj is FastAndSlowPicksType<T> {
	const candidate = obj as FastAndSlowPicksType<T>;

	return Array.isArray(candidate.picks) && candidate.additionalPicks instanceof Promise;
}

export abstract class PickerQuickAccessProvider<T extends IPickerQuickAccessItem> extends Disposable implements IQuickAccessProvider {

	private static FAST_PICKS_RACE_DELAY = 200; // timeout before we accept fast results before slow results are present

	constructor(private prefix: string, protected options?: IPickerQuickAccessProviderOptions) {
		super();
	}

	provide(picker: IQuickPick<T>, token: CancellationToken): IDisposable {
		const disposables = new DisposableStore();

		// Apply options if any
		picker.canAcceptInBackground = !!this.options?.canAcceptInBackground;

		// Disable filtering & sorting, we control the results
		picker.matchOnLabel = picker.matchOnDescription = picker.matchOnDetail = picker.sortByLabel = false;

		// Set initial picks and update on type
		let picksCts: CancellationTokenSource | undefined = undefined;
		const updatePickerItems = async () => {

			// Cancel any previous ask for picks and busy
			picksCts?.dispose(true);
			picker.busy = false;

			// Create new cancellation source for this run
			picksCts = new CancellationTokenSource(token);

			// Collect picks and support both long running and short or combined
			const picksToken = picksCts.token;
			const res = this.getPicks(picker.value.substr(this.prefix.length).trim(), disposables.add(new DisposableStore()), picksToken);

			// No Picks
			if (res === null) {
				// Ignore
			}

			// Fast and Slow Picks
			else if (isFastAndSlowPicksType(res)) {
				let fastPicksHandlerDone = false;
				let slowPicksHandlerDone = false;

				await Promise.all([

					// Fast Picks: to reduce amount of flicker, we race against
					// the slow picks over 500ms and then set the fast picks.
					// If the slow picks are faster, we reduce the flicker by
					// only setting the items once.
					(async () => {
						try {
							await timeout(PickerQuickAccessProvider.FAST_PICKS_RACE_DELAY);
							if (picksToken.isCancellationRequested) {
								return;
							}

							if (!slowPicksHandlerDone) {
								picker.items = res.picks;
							}
						} finally {
							fastPicksHandlerDone = true;
						}
					})(),

					// Slow Picks: we await the slow picks and then set them at
					// once together with the fast picks, but only if we actually
					// have additional results.
					(async () => {
						picker.busy = true;
						try {
							const additionalPicks = await res.additionalPicks;
							if (picksToken.isCancellationRequested) {
								return;
							}

							if (additionalPicks.length > 0 || !fastPicksHandlerDone) {
								picker.items = [...res.picks, ...additionalPicks];
							}
						} finally {
							if (!picksToken.isCancellationRequested) {
								picker.busy = false;
							}

							slowPicksHandlerDone = true;
						}
					})()
				]);
			}

			// Fast Picks
			else if (Array.isArray(res)) {
				picker.items = res;
			}

			// Slow Picks
			else {
				picker.busy = true;
				try {
					const items = await res;
					if (picksToken.isCancellationRequested) {
						return;
					}

					picker.items = items;
				} finally {
					if (!picksToken.isCancellationRequested) {
						picker.busy = false;
					}
				}
			}
		};
		disposables.add(picker.onDidChangeValue(() => updatePickerItems()));
		updatePickerItems();

		// Accept the pick on accept and hide picker
		disposables.add(picker.onDidAccept(event => {
			const [item] = picker.selectedItems;
			if (typeof item?.accept === 'function') {
				if (!event.inBackground) {
					picker.hide(); // hide picker unless we accept in background
				}
				item.accept(picker.keyMods, event);
			}
		}));

		// Trigger the pick with button index if button triggered
		disposables.add(picker.onDidTriggerItemButton(async ({ button, item }) => {
			if (typeof item.trigger === 'function') {
				const buttonIndex = item.buttons?.indexOf(button) ?? -1;
				if (buttonIndex >= 0) {
					const result = item.trigger(buttonIndex, picker.keyMods);
					const action = (typeof result === 'number') ? result : await result;

					if (token.isCancellationRequested) {
						return;
					}

					switch (action) {
						case TriggerAction.NO_ACTION:
							break;
						case TriggerAction.CLOSE_PICKER:
							picker.hide();
							break;
						case TriggerAction.REFRESH_PICKER:
							updatePickerItems();
							break;
					}
				}
			}
		}));

		return disposables;
	}

	/**
	 * Returns an array of picks and separators as needed. If the picks are resolved
	 * long running, the provided cancellation token should be used to cancel the
	 * operation when the token signals this.
	 *
	 * The implementor is responsible for filtering and sorting the picks given the
	 * provided `filter`.
	 *
	 * @param filter a filter to apply to the picks.
	 * @param disposables can be used to register disposables that should be cleaned
	 * up when the picker closes.
	 * @param token for long running tasks, implementors need to check on cancellation
	 * through this token.
	 * @returns the picks either directly, as promise or combined fast and slow results.
	 * Pickers can return `null` to signal that no change in picks is needed.
	 */
	protected abstract getPicks(filter: string, disposables: DisposableStore, token: CancellationToken): Array<T | IQuickPickSeparator> | Promise<Array<T | IQuickPickSeparator>> | FastAndSlowPicksType<T> | null;
}
