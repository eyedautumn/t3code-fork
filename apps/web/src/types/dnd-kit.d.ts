declare module "@dnd-kit/core" {
  export type CollisionDetection = (args: any) => any;
  export type DragCancelEvent = any;
  export type DragStartEvent = any;
  export type DragEndEvent = any;
  export const DndContext: any;
  export const PointerSensor: any;
  export const closestCorners: any;
  export const pointerWithin: any;
  export const useSensor: any;
  export const useSensors: any;
}

declare module "@dnd-kit/sortable" {
  export const SortableContext: any;
  export const useSortable: any;
  export const verticalListSortingStrategy: any;
}

declare module "@dnd-kit/modifiers" {
  export const restrictToFirstScrollableAncestor: any;
  export const restrictToVerticalAxis: any;
}

declare module "@dnd-kit/utilities" {
  export const CSS: any;
}
