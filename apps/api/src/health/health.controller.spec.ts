import { Test, TestingModule } from "@nestjs/testing";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

describe("HealthController", () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: { checkReadiness: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(HealthController);
  });

  it("liveness returns ok with a timestamp", () => {
    const result = controller.liveness();
    expect(result.status).toBe("ok");
    expect(typeof result.timestamp).toBe("string");
    expect(new Date(result.timestamp).toString()).not.toBe("Invalid Date");
  });
});
