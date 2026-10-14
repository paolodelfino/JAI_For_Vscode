// Edge-case fixture for the outline reconstruction (tokenizing only).

One_Line :: struct { alpha: int; beta: string; }

One_Enum :: enum { FIRST, SECOND, THIRD }

multiline_proc ::
    (first: int,
     second: string) -> bool
{
    local_type :: struct { value: int; }
    return true;
}

gap_proc /* comment between name and :: */ :: () {
}

with_blocks :: () {
    if true {
        deep_local := 1;
        deep_proc :: () {
        }
    }

    for (idx: 0..2) {
        loop_local := idx;
    }

    thing := struct {
        inner_field: int;
    };
}

Drawable :: interface {
    draw :: (handle: int) -> void;
}
