// Sample Jai file for token analysis.
// It deliberately exercises every construct the outline should find,
// including NESTED definitions. It is meant for tokenizing, not compiling.

#import "Basic";

PI :: 3.14159265358979;
MAX_ENTITIES :: 1024;
GREETING :: "Hello, Jai!\n";
HERE :: #string HERE_END
    braces { inside } a here-string must not affect nesting
HERE_END
QUOTE_CHAR :: #char "\"";

global_counter: int;               // global variables (: Type and :=)
global_name := "mutable global";

// ---- Type declarations -------------------------------------------------

Vector3 :: struct {
    x: float;
    y: float;
    z: float = 0.0;
}

Point2 :: struct {
    x, y: float;                   // multiple declarators in one statement
}

Array_Of :: struct (T: Type) {     // parameterized (polymorphic) struct
    data:  *T;
    count: int;
}

Entity :: struct {
    id:    u64;
    pos:   Vector3;
    vel:   Vector3;
    name:  string;
    flags: Entity_Flags;
    using transform: Transform;   // anonymous / using member

    Transform :: struct {          // nested type declaration
        rotation: float;
        scale:    float;
    }
}

Entity_Flags :: enum_flags {
    ALIVE       :: 0x1;
    VISIBLE     :: 0x2;
    SELECTED    :: 0x4;
}

State :: enum {
    IDLE;
    RUNNING;
    JUMPING :: 10;                 // explicit value
    FALLING;
}

Shape :: union {
    circle_radius: float;
    rect: struct { w: float; h: float; };  // anonymous inline struct type
}

Alias_Type :: #type Vector3;
Procedure_Type :: #type (int, string) -> bool;

// ---- Procedure declarations ---------------------------------------------

main :: () {
    print("PI is %\n", PI);
}

add :: (a: Vector3, b: Vector3) -> Vector3 {
    result: Vector3;
    result.x = a.x + b.x;
    result.y = a.y + b.y;
    result.z = a.z + b.z;
    return result;
}

inline_length :: inline (v: Vector3) -> float {
    return __sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

no_body :: (x: int) -> int;        // declaration without a body?

foreign_puts :: (s: *u8) -> s32 #foreign "puts";
variadic :: (args: ..) -> void { /* ... */ }

apply :: ($T: Type, value: T, fn: (T) -> T) -> T {   // polymorphic procedure
    return fn(value);
}

operator * :: (a: Vector3, s: float) -> Vector3 {    // operator overload
    return .{a.x * s, a.y * s, a.z * s};
}

// ---- Nested definitions --------------------------------------------------

outer_procedure :: () {
    Local_Config :: struct {       // nested type inside a procedure body
        width:  int;
        height: int;
    }

    LOCAL_LIMIT :: 42;             // nested constant

    helper :: (x: int) -> int {    // nested procedure
        inner_helper :: () -> int {   // doubly nested procedure
            return 7;
        }
        return x * 2 + inner_helper();
    }

    config := Local_Config.{ 1920, 1080 };
    counter := 0;                  // plain local variables (:= and : Type)
    typed_local: int = 5;

    handler := (message: string) { // anonymous procedure assigned to a variable
        print("handler: %\n", message);
    };

    for i: 0..9 {
        if i == 3 {
            text := "brace } and { inside a string";
            // a comment with a brace } must not close anything
            /* a block comment { with } nested /* inner */ braces */
            counter += helper(i);
        }
    }

    while counter < 100 {
        defer print("deferred\n");
        break;
    }
}

// ---- Compile-time execution at file scope (#run) -------------------------
//
// File scope is a data scope: it contains declarations, not ordinary
// statements. Imperative code at file scope therefore runs at compile time
// via #run, and its declarations are locals (not globals).

#run {
    run_block_value := 12;
    run_block_count := 1;
}

#run,stallable direct_run_value := 12;

both_global_and_constant :: 1;

#if AT_COMPILE_TIME {
    #run,stallable {
        set_build_options_dc(.{do_output=false});
        options := get_build_options();
        args := options.compile_time_command_line;
        if !generate_bindings(args) {
            compiler_set_workspace_status(.FAILED);
        }
        
        only_a_constant :: 1;
    }
} else {
    #import "System";

    main :: () {
        set_working_directory(path_strip_filename(get_path_of_running_executable()));
        args := get_command_line_arguments();
        if !generate_bindings(`args) {
            exit(1);
        }
    }
}

#run {
    non_global_procedure :: () {

    }
}
