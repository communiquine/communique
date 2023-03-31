interface UserState {
	topic: Selectable;
	email: Selectable;
	recipient: Selectable;
	spotlight: Selectable;
	template: Layout;
	[key: string];
}

interface BigInt {
	toJSON(): string;
}