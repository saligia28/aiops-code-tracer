package com.demo;

@RestController
@RequestMapping("/users")
public class UserController {
    @Autowired
    private UserService userService;

    @GetMapping("/{id}")
    public User getById(Long id) {
        return userService.findById(id);
    }

    @PostMapping
    public void create(User user) {
    }
}
