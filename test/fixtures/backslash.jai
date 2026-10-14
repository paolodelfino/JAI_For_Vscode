// Backslash-continued identifiers: `\` + spaces joins the next segment
// into the same identifier; the name is the segments concatenated.

left\_margin := 1;
free\   variable := 2;
short\          : int;

Vector\ 3 :: struct {
    x: float;
}

make\ thing :: (input\ value: int) -> int {
    local\ value := input\ value;
    return local\ value;
}
